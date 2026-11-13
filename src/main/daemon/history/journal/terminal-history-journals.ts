import { existsSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { PrioritySemaphore } from '../../../../shared/priority-semaphore'
import { ensurePrivateDir } from '../../endpoint/publication/daemon-private-file-modes'
import { DAEMON_HISTORY_RESIZE_MODEL } from '../../protocol/daemon-history-replay-pty'
import { TerminalHistoryUnavailableError } from '../../protocol/daemon-history-protocol'
import { getHistorySessionDirName } from '../storage/history-paths'
import { LOG_HEADER_BYTES } from '../storage/terminal-history-log'
import { hasTerminalHistoryRecoveryProtection } from '../storage/terminal-history-recovery-quarantine'
import {
  newTerminalHistoryMeta,
  readTerminalHistoryMeta,
  writeTerminalHistoryMeta,
  type SessionMeta
} from '../storage/terminal-history-metadata'
import { TerminalSessionJournal } from './terminal-session-journal'
import { TerminalHistoryReads } from './terminal-history-read-admission'
import type { TerminalSessionJournalReads } from './terminal-session-journal-reads'

// Backing for queued, in-flight and frozen inputs across every journal on this host.
export const JOURNAL_HOST_BACKLOG_BYTES = 64 * 1024 * 1024
const PREDECESSOR_SETTLE_WAIT_MS = 10_000

export type TerminalHistoryHold = {
  sessionId: string
  preservesRecovery: boolean
  /** What the hold replaced: the prior metadata, or null when it created the metadata. */
  replaced?: SessionMeta | null
}

/** The daemon's single owner of its host-local history root. */
export class TerminalHistoryJournals {
  private readonly replay = new PrioritySemaphore(1)
  readonly reads = new TerminalHistoryReads(
    (frozenBytes) => this.backlogBytes + frozenBytes <= JOURNAL_HOST_BACKLOG_BYTES
  )
  // Latest journal per ID until its actual I/O settles; a successor waits on it.
  private readonly byId = new Map<string, TerminalSessionJournal>()
  private readonly open = new Set<TerminalSessionJournalReads>()
  // Written holds not yet consumed by a journal; only the latest per ID may roll back.
  private readonly holds = new Map<string, TerminalHistoryHold>()
  private backlogBytes = 0

  constructor(
    readonly root: string,
    private readonly logger?: { log(event: string, details: Record<string, unknown>): void }
  ) {}

  /**
   * Before any fresh physical spawn: wait for the predecessor's actual I/O, then make the shared
   * root's metadata hold the ID for prior-stable readers. Throws rather than start unmarked.
   */
  async prepareHold(
    sessionId: string,
    opts: { cwd: string; cols: number; rows: number; deadlineAt?: number }
  ): Promise<TerminalHistoryHold> {
    const predecessor = this.byId.get(sessionId)
    if (predecessor) {
      const waitMs = Math.min(
        PREDECESSOR_SETTLE_WAIT_MS,
        Math.max(0, (opts.deadlineAt ?? Number.POSITIVE_INFINITY) - Date.now())
      )
      let timer: ReturnType<typeof setTimeout> | undefined
      const settled = await Promise.race([
        predecessor.settled.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), waitMs)
          timer.unref?.()
        })
      ])
      clearTimeout(timer)
      if (!settled) {
        throw new TerminalHistoryUnavailableError()
      }
    }
    const dir = join(this.root, getHistorySessionDirName(sessionId))
    try {
      if (hasTerminalHistoryRecoveryProtection(this.root, sessionId)) {
        return { sessionId, preservesRecovery: true }
      }
      const meta = readTerminalHistoryMeta(this.root, sessionId)
      if (meta.status === 'unreadable') {
        return { sessionId, preservesRecovery: true }
      }
      if (meta.status === 'readable') {
        const preservesRecovery = meta.meta.endedAt === null && hasReplayableFiles(dir)
        if (meta.meta.endedAt === null && meta.meta.exitCode === null) {
          return { sessionId, preservesRecovery }
        }
        // Only the hold fields change; recovery geometry stays with its checkpoint.
        writeTerminalHistoryMeta(dir, { ...meta.meta, endedAt: null, exitCode: null })
        return this.track({ sessionId, preservesRecovery, replaced: meta.meta })
      }
      ensurePrivateDir(dir)
      writeTerminalHistoryMeta(dir, newTerminalHistoryMeta(opts, DAEMON_HISTORY_RESIZE_MODEL))
      return this.track({ sessionId, preservesRecovery: false, replaced: null })
    } catch (error) {
      this.logger?.log('terminal-history-hold-failed', {
        message: error instanceof Error ? error.message : String(error)
      })
      throw new TerminalHistoryUnavailableError()
    }
  }

  /** No process started: put back what the hold replaced, unless a later hold took the ID. */
  rollbackHold(hold: TerminalHistoryHold): void {
    if (this.holds.get(hold.sessionId) !== hold) {
      return
    }
    this.holds.delete(hold.sessionId)
    const dir = join(this.root, getHistorySessionDirName(hold.sessionId))
    try {
      if (hold.replaced) {
        writeTerminalHistoryMeta(dir, hold.replaced)
      } else {
        unlinkSync(join(dir, 'meta.json'))
      }
    } catch (error) {
      this.logger?.log('terminal-history-hold-rollback-failed', {
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** Ends an unused hold's bookkeeping without touching the metadata it wrote. */
  retireHold(hold: TerminalHistoryHold): void {
    if (this.holds.get(hold.sessionId) === hold) {
      this.holds.delete(hold.sessionId)
    }
  }

  /** Created before the Session subscribes to output so the first applied byte is journaled. */
  openJournal(
    hold: TerminalHistoryHold,
    origin: { cwd: string; cols: number; rows: number; wslDistro: string | undefined }
  ): TerminalSessionJournal {
    if (this.holds.get(hold.sessionId) === hold) {
      this.holds.delete(hold.sessionId)
    }
    const journal = new TerminalSessionJournal(
      {
        acquireReplay: (priority, signal) => this.replay.acquire(priority, signal),
        images: this.reads.images,
        charge: (owner, bytes) => this.charge(owner, bytes),
        makeRoom: (bytes) => {
          if (this.backlogBytes + this.reads.readSourceBytes + bytes > JOURNAL_HOST_BACKLOG_BYTES) {
            this.reads.relievePressure()
          }
        },
        settled: (owner) => this.release(hold.sessionId, owner),
        log: (event, details) => this.logger?.log(event, details),
        owns: (owner) => this.byId.get(hold.sessionId) === owner
      },
      this.root,
      getHistorySessionDirName(hold.sessionId),
      { ...origin, preservesRecovery: hold.preservesRecovery }
    )
    this.byId.set(hold.sessionId, journal)
    this.open.add(journal)
    return journal
  }

  /** The journal of the live incarnation, optionally only the expected one. */
  live(sessionId: string, expectedIncarnationId?: string): TerminalSessionJournal | undefined {
    const journal = this.byId.get(sessionId)
    return journal?.session &&
      (expectedIncarnationId === undefined || journal.incarnation === expectedIncarnationId)
      ? journal
      : undefined
  }

  /** Bounded by the daemon's existing shutdown deadline; unsettled journals stay unclean. */
  async settleAll(): Promise<void> {
    await Promise.all([...this.byId.values()].map((journal) => journal.settled))
  }

  private track(hold: TerminalHistoryHold): TerminalHistoryHold {
    this.holds.set(hold.sessionId, hold)
    return hold
  }

  private charge(journal: TerminalSessionJournalReads, bytes: number): void {
    this.backlogBytes += bytes
    if (
      bytes <= 0 ||
      this.backlogBytes + this.reads.readSourceBytes <= JOURNAL_HOST_BACKLOG_BYTES
    ) {
      return
    }
    this.reads.relievePressure()
    if (this.backlogBytes <= JOURNAL_HOST_BACKLOG_BYTES) {
      return
    }
    let largest = journal
    for (const candidate of this.open) {
      if (candidate.backlog > largest.backlog) {
        largest = candidate
      }
    }
    largest.gap('host_backlog_exhausted')
  }

  private release(sessionId: string, journal: TerminalSessionJournalReads): void {
    this.open.delete(journal)
    if (this.byId.get(sessionId) === journal) {
      this.byId.delete(sessionId)
    }
  }
}

function hasReplayableFiles(dir: string): boolean {
  if (existsSync(join(dir, 'checkpoint.json')) || existsSync(join(dir, 'scrollback.bin'))) {
    return true
  }
  try {
    return statSync(join(dir, 'output.log')).size > LOG_HEADER_BYTES
  } catch {
    return false
  }
}
