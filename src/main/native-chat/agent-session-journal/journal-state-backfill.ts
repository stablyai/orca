// One maintenance runner per database converts and repairs chats one at a time, open or closed:
// a chat that opens mid-conversion keeps the same runner, so no progress is handed over or lost.

import type Database from '../../sqlite/sync-database'
import { sweepJournalOutcomePage } from './journal-outcome-cleanup'
import type { JournalHostDatabase } from './journal-host-database'
import { JournalProjectionCatchUp, type JournalCatchUpPacing } from './journal-projection-catch-up'
import {
  createJournalPace,
  journalMaintenanceDelay,
  registerJournalMaintenance,
  type JournalPace
} from './journal-maintenance'
import { isSqliteDriverError } from '../../sqlite/sqlite-read-failure'
import { AgentSessionJournalError } from './journal-write-guards'
import {
  logJournalProjectionFailure,
  sweepJournalSavedState,
  unrefJournalProjectionTimer
} from './journal-saved-state'
import { JOURNAL_STATE_CODEC_VERSION } from './journal-state-codec'

const FIRST_PASS_MS = 60_000
const PASS_INTERVAL_MS = 6 * 60 * 60_000
const REQUEST_DELAY_MS = 1_000
const MAX_RETRY_DELAY_MS = 60 * 60_000

type Pending = { sessionId: string; epoch: string; lastSequence: number }

export class JournalMaintenanceRunner {
  /** Session to the epoch and newest sequence its content could not convert or cache; a new row
   * changes the sequence and re-arms it. In memory: a relaunch tries once more. */
  readonly parked = new Map<string, string>()
  private readonly retry = new Map<string, { failures: number; at: number }>()
  private readonly requested = new Set<string>()
  /** Requested chats still backing off; they rejoin the queue when the run ends. */
  private readonly deferred = new Set<string>()
  private readonly pace: JournalPace
  private running: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** One timer wakes the runner at the earlier of the next periodic pass and the first due request
   * or retry, so neither can push the other back. */
  private dueFull = Number.POSITIVE_INFINITY
  private dueRequest = Number.POSITIVE_INFINITY
  private stopped = false
  private unregister: (() => void) | null = null

  constructor(
    private readonly deps: {
      database: () => JournalHostDatabase | null
      now?: () => number
      delay?: (ms: number) => Promise<void>
    }
  ) {
    this.pace = createJournalPace(
      deps.now ?? (() => performance.now()),
      deps.delay ?? journalMaintenanceDelay
    )
  }

  start(): this {
    const database = this.current()
    if (database) {
      this.unregister = registerJournalMaintenance(database.db, (sessionId) =>
        this.request(sessionId)
      )
    }
    this.dueFull = this.clock() + FIRST_PASS_MS
    this.arm()
    return this
  }

  stop(): void {
    this.stopped = true
    this.unregister?.()
    this.clearTimer()
  }

  /** A chat whose saved state lags its writes is served next, ahead of the periodic pass. */
  request(sessionId: string): void {
    if (this.stopped || this.requested.has(sessionId)) {
      return
    }
    this.requested.add(sessionId)
    this.dueRequest = Math.min(this.dueRequest, this.clock() + REQUEST_DELAY_MS)
    this.arm()
  }

  /** Sweeps, then every chat whose saved state lags; requested chats go first. */
  pass(full = true): Promise<void> {
    this.running ??= this.run(full).finally(() => {
      this.running = null
      this.deferred.forEach((sessionId) => this.requested.add(sessionId))
      this.deferred.clear()
      // Each chat still waiting is due at its retry, and never sooner than a request's delay.
      const soonest = this.clock() + REQUEST_DELAY_MS
      this.dueRequest = Math.min(
        ...[...this.requested].map((sessionId) =>
          Math.max(soonest, this.retry.get(sessionId)?.at ?? 0)
        )
      )
      if (full) {
        this.dueFull = this.clock() + PASS_INTERVAL_MS
      }
      this.arm()
    })
    return this.running
  }

  private async run(full: boolean): Promise<void> {
    const database = this.current()
    if (!database) {
      return
    }
    if (full) {
      while (this.current() && this.pace.work(() => sweepJournalOutcomePage(database))) {
        await this.pace.rest()
      }
      while (this.current() && this.pace.work(() => sweepJournalSavedState(database))) {
        await this.pace.rest()
      }
    }
    const listed = full ? this.pace.work(() => lagging(database.db)) : []
    for (;;) {
      const next = this.takeRequested(database) ?? listed.shift()
      if (!next || !this.current()) {
        return
      }
      await this.serve(database, next)
    }
  }

  private takeRequested(database: JournalHostDatabase): Pending | undefined {
    for (const sessionId of this.requested) {
      this.requested.delete(sessionId)
      const [pending] = this.pace.work(() => lagging(database.db, sessionId))
      if (pending) {
        return pending
      }
    }
    return undefined
  }

  private async serve(database: JournalHostDatabase, pending: Pending): Promise<void> {
    const { sessionId, epoch } = pending
    const attempt = `${epoch}\n${pending.lastSequence}`
    const retry = this.retry.get(sessionId)
    if (this.parked.get(sessionId) === attempt) {
      return
    }
    if (retry && retry.at > this.clock()) {
      this.deferred.add(sessionId)
      return
    }
    const catchUp = new JournalProjectionCatchUp(database, sessionId, epoch)
    const pacing: JournalCatchUpPacing = {
      work: this.pace.work,
      rest: async () => {
        await this.pace.rest()
        return this.current() !== null
      }
    }
    try {
      for (;;) {
        if (!(await pacing.rest()) || (await catchUp.load(pacing)) === 'stopped') {
          // A busy, replaced or closing chat is skipped; the pass continues with the rest.
          return
        }
        const step = this.pace.work(() => catchUp.page())
        if (step === 'parked' || step === 'failed') {
          this.fail(sessionId, attempt, step === 'parked' ? null : catchUp.failure)
          return
        }
        // 'stale' means the load swept a retired page instead of taking the chat: try it again.
        if (step !== 'advanced' && step !== 'stale') {
          this.retry.delete(sessionId)
          return
        }
      }
    } catch (error) {
      this.fail(sessionId, attempt, error)
    } finally {
      catchUp.close()
    }
  }

  /** Content this build cannot convert parks until the chat's rows change; a storage failure, which
   * a retry can clear, backs off 1 s quadrupling to an hour. */
  private fail(sessionId: string, attempt: string, error: unknown): void {
    if (error !== null) {
      logJournalProjectionFailure(sessionId, error)
    }
    const transient =
      isSqliteDriverError(error) ||
      (error instanceof AgentSessionJournalError && error.code === 'journal_closed')
    if (!transient) {
      this.parked.set(sessionId, attempt)
      return
    }
    const failures = (this.retry.get(sessionId)?.failures ?? 0) + 1
    const delay = Math.min(REQUEST_DELAY_MS * 4 ** failures, MAX_RETRY_DELAY_MS)
    this.retry.set(sessionId, { failures, at: this.clock() + delay })
    this.deferred.add(sessionId)
  }

  /** A running pass re-arms when it ends; a periodic pass that is due serves requests too. */
  private arm(): void {
    if (this.stopped || this.running) {
      return
    }
    this.clearTimer()
    const full = this.dueFull <= this.dueRequest
    const at = Math.min(this.dueFull, this.dueRequest)
    if (!Number.isFinite(at)) {
      return
    }
    this.timer = setTimeout(
      () => {
        this.timer = null
        if (full) {
          this.dueFull = Number.POSITIVE_INFINITY
        }
        void this.pass(full).catch((error: unknown) => logJournalProjectionFailure('', error))
      },
      Math.max(0, at - this.clock())
    )
    unrefJournalProjectionTimer(this.timer)
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
  }

  private clock(): number {
    return (this.deps.now ?? Date.now)()
  }

  private current(): JournalHostDatabase | null {
    const database = this.deps.database()
    return this.stopped || !database || database.isClosed || database.readOnly ? null : database
  }
}

/** Chats without published outcomes, or whose cache is unstamped, behind, or of another codec. */
function lagging(db: Database.Database, sessionId?: string): Pending[] {
  return db
    .prepare(`SELECT s.session_id, s.epoch,
      COALESCE(e.through_seq, (SELECT MAX(r.seq) FROM journal_rows r
        WHERE r.session_id = s.session_id AND r.epoch = s.epoch)) AS last_seq
    FROM journal_sessions s
    LEFT JOIN journal_outcome_epochs e ON e.session_id = s.session_id AND e.epoch = s.epoch
    LEFT JOIN journal_state c ON c.session_id = s.session_id AND c.epoch = s.epoch
    WHERE (? IS NULL OR s.session_id = ?) AND (e.session_id IS NULL OR c.generation IS NULL
      OR c.generation != e.generation OR c.through_seq < e.through_seq OR c.version != ?)
    ORDER BY s.session_id`)
    .all(sessionId ?? null, sessionId ?? null, JOURNAL_STATE_CODEC_VERSION)
    .flatMap(({ session_id: id, epoch, last_seq: lastSequence }) =>
      typeof id === 'string' && typeof epoch === 'string' && typeof lastSequence === 'number'
        ? [{ sessionId: id, epoch, lastSequence }]
        : []
    )
}

/** The host's runner for its journal database; stopping it ends its timers. */
export function startJournalStateBackfill(
  run: { database: () => JournalHostDatabase | null },
  onError: (error: unknown) => void
): { stop: () => void } {
  const runner = new JournalMaintenanceRunner(run)
  try {
    runner.start()
  } catch (error) {
    onError(error)
  }
  return { stop: () => runner.stop() }
}
