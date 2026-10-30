// Closed chats catch up page by page between rests; an open chat takes over at a page boundary.

import type { JournalHostDatabase } from './journal-host-database'
import { journalCatchUpPace, JournalProjectionCatchUp } from './journal-projection-catch-up'
import {
  logJournalProjectionFailure,
  sweepJournalSavedState,
  unrefJournalProjectionTimer
} from './journal-saved-state'

export type JournalStateBackfillRun = {
  database: () => JournalHostDatabase | null
  repairOpen: (sessionId: string) => Promise<boolean>
  stopped: () => boolean
  now?: () => number
  rest?: (ms: number) => Promise<void>
  /** Session to the epoch and newest sequence whose fold could not publish; new rows re-arm it. */
  unpublishable?: Map<string, string>
}

export async function backfillJournalState(run: JournalStateBackfillRun): Promise<void> {
  const pace = journalCatchUpPace(run.now, run.rest)
  const current = (): JournalHostDatabase | null => {
    const database = run.database()
    return run.stopped() || !database || database.isClosed || database.readOnly ? null : database
  }
  // The pace charges only this pass's own units, never an open chat's catch-up it waited for.
  const pacing = {
    work: pace.work,
    rest: async (): Promise<boolean> => {
      await pace.rest()
      return current() !== null
    }
  }
  const database = current()
  if (!database) {
    return
  }
  pace.work(() => sweepJournalSavedState(database))
  const sessions = pace.work(() =>
    database.db
      .prepare(`SELECT s.session_id, s.epoch,
      (SELECT MAX(r.seq) FROM journal_rows r
        WHERE r.session_id = s.session_id AND r.epoch = s.epoch) AS last_seq
    FROM journal_sessions s
    LEFT JOIN journal_state c ON c.session_id = s.session_id AND c.epoch = s.epoch
    WHERE c.through_seq IS NULL OR c.through_seq < (
      SELECT MAX(r.seq) FROM journal_rows r
        WHERE r.session_id = s.session_id AND r.epoch = s.epoch
    ) ORDER BY s.session_id`)
      .all()
  )
  for (const session of sessions) {
    const { session_id: sessionId, epoch, last_seq: lastSequence } = session
    if (
      typeof sessionId !== 'string' ||
      typeof epoch !== 'string' ||
      typeof lastSequence !== 'number'
    ) {
      continue
    }
    const attempt = `${epoch}\n${lastSequence}`
    if (run.unpublishable?.get(sessionId) === attempt) {
      continue
    }
    try {
      const catchUp = new JournalProjectionCatchUp(database, sessionId, epoch)
      for (;;) {
        if (!(await pacing.rest())) {
          return
        }
        // An open chat owns its lane and continues from the last committed page.
        if (await run.repairOpen(sessionId)) {
          break
        }
        const loaded = await catchUp.load(pacing)
        if (loaded === 'stopped' || !current()) {
          return
        }
        const step = loaded === 'parked' ? 'parked' : pace.work(() => catchUp.page())
        if (step === 'parked') {
          run.unpublishable?.set(sessionId, attempt)
        }
        if (step !== 'advanced' && step !== 'stale') {
          break
        }
      }
    } catch (error) {
      logJournalProjectionFailure(sessionId, error)
    }
  }
}

export function startJournalStateBackfill(
  run: Omit<JournalStateBackfillRun, 'stopped'>,
  onError: (error: unknown) => void
): { stop: () => void } {
  let stopped = false
  let timer: ReturnType<typeof setTimeout>
  const unpublishable = new Map<string, string>()
  const schedule = (delay: number): void => {
    timer = setTimeout(() => {
      void backfillJournalState({ ...run, stopped: () => stopped, unpublishable })
        .catch(onError)
        .finally(() => {
          if (!stopped) {
            schedule(6 * 60 * 60 * 1_000)
          }
        })
    }, delay)
    unrefJournalProjectionTimer(timer)
  }
  schedule(60 * 1_000)
  return {
    stop: () => {
      stopped = true
      clearTimeout(timer)
    }
  }
}
