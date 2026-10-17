import type Database from '../../sqlite/sync-database'
import { journalPragmaNumber, type JournalTransaction } from './journal-database'
import { JournalPrunePass } from './journal-prune-pass'
import {
  collectJournalPruneGarbage,
  journalPruneEpochLookup,
  JournalPruneRefusal,
  readJournalPruneBounds,
  readJournalPruneSessionPage,
  type JournalPruneCursor,
  type JournalPruneEpoch
} from './journal-prune-state'

const QUIET_DELAY_MS = 30_000
const PASS_DELAY_MS = 10
const VACUUM_PAGES = 1

/** Owed work is derived from saved frontiers, so a restart resumes instead of rescanning. */
export class JournalMaintenance {
  private timer: NodeJS.Timeout | null = null
  private sweepAt: number | null
  private readonly readyAt = new Map<string, number>()
  private sessions: JournalPruneCursor<string> | null = null
  private garbage: JournalPruneCursor<JournalPruneEpoch> | null = null
  private current: JournalPrunePass | null = null
  private closed = false
  private vacuumPending = true
  private garbageTurn = true

  constructor(
    private readonly database: () => Database.Database,
    private readonly transaction: JournalTransaction,
    initialDelayMs = QUIET_DELAY_MS
  ) {
    this.sweepAt = Date.now() + initialDelayMs
    this.schedule(initialDelayMs)
  }

  appended(sessionId: string): void {
    if (this.closed) {
      return
    }
    if (!this.readyAt.has(sessionId)) {
      this.readyAt.set(sessionId, Date.now() + QUIET_DELAY_MS)
    }
    this.changed()
  }

  changed(): void {
    if (this.closed) {
      return
    }
    this.vacuumPending = true
    this.sweepAt ??= Date.now() + QUIET_DELAY_MS
    this.schedule(QUIET_DELAY_MS)
  }

  close(): void {
    this.closed = true
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
    this.current = null
    this.sessions = null
    this.garbage = null
    this.readyAt.clear()
  }

  private stop(error: unknown): void {
    this.close()
    console.warn('[journal-maintenance] stopped:', error)
  }

  private schedule(delay: number): void {
    if (this.timer || this.closed) {
      return
    }
    const setNodeTimeout: (run: () => void, ms: number) => NodeJS.Timeout = setTimeout
    this.timer = setNodeTimeout(() => this.advance(), delay)
    this.timer.unref()
  }

  private advance(): void {
    this.timer = null
    try {
      const db = this.database()
      if (
        !this.current &&
        !this.sessions &&
        !this.garbage &&
        this.sweepAt !== null &&
        this.sweepAt <= Date.now()
      ) {
        this.sweepAt = null
        this.startSweep(db)
        if (this.vacuumPending) {
          this.vacuumPending = this.reclaim(db)
        }
      } else if (this.garbageTurn && this.garbage) {
        const result = collectJournalPruneGarbage(db, this.transaction, this.garbage)
        this.vacuumPending ||= result.collected
        if (!result.more) {
          this.garbage = null
        }
      } else {
        this.step(db)
      }
      this.garbageTurn = !this.garbageTurn
      if (this.current || this.sessions || this.garbage || this.vacuumPending) {
        this.schedule(PASS_DELAY_MS)
      } else if (this.sweepAt !== null) {
        this.schedule(Math.max(PASS_DELAY_MS, this.sweepAt - Date.now()))
      }
    } catch (error) {
      this.stop(error)
    }
  }

  private step(db: Database.Database): void {
    const pass = this.current
    if (!pass) {
      if (this.sessions) {
        this.nextSession(db)
      } else if (this.vacuumPending) {
        this.vacuumPending = this.reclaim(db)
      }
      return
    }
    try {
      const result = pass.step(db, this.transaction)
      this.vacuumPending ||= !result.done
      if (!result.done) {
        return
      }
    } catch (error) {
      if (!(error instanceof JournalPruneRefusal)) {
        throw error
      }
      pass.refuse(this.transaction)
      console.warn('[journal-maintenance] skipped epoch:', {
        sessionId: pass.sessionId,
        epoch: pass.epoch,
        reason: error.message
      })
    }
    this.current = null
    if (journalPruneEpochLookup(db)(pass.sessionId) !== null) {
      const at = this.readyAt.get(pass.sessionId) ?? Date.now() + QUIET_DELAY_MS
      this.readyAt.set(pass.sessionId, at)
      this.sweepAt = Math.min(this.sweepAt ?? at, at)
    } else {
      this.readyAt.delete(pass.sessionId)
    }
  }

  private startSweep(db: Database.Database): void {
    const { session, progress } = readJournalPruneBounds(db)
    this.sessions = session === null ? null : { after: null, through: session }
    this.garbage = progress === null ? null : { after: null, through: progress }
  }

  /** Raw healthy keys count toward the page budget, and admitted chats wait behind the cursor. */
  private nextSession(db: Database.Database): void {
    const cursor = this.sessions
    if (!cursor) {
      return
    }
    const page = readJournalPruneSessionPage(db, cursor)
    const lookup = journalPruneEpochLookup(db)
    for (const sessionId of page) {
      cursor.after = sessionId
      const epoch = lookup(sessionId)
      if (epoch === null) {
        this.readyAt.delete(sessionId)
        continue
      }
      const at = this.readyAt.get(sessionId) ?? 0
      if (at > Date.now()) {
        this.sweepAt = Math.min(this.sweepAt ?? at, at)
        continue
      }
      this.readyAt.delete(sessionId)
      this.sweepAt ??= Date.now() + QUIET_DELAY_MS
      this.current = new JournalPrunePass(db, sessionId, epoch)
      return
    }
    if (page.length < 32 || cursor.after === cursor.through) {
      this.sessions = null
    }
  }

  private reclaim(db: Database.Database): boolean {
    if (journalPragmaNumber(db, 'auto_vacuum') !== 2) {
      return false
    }
    const before = journalPragmaNumber(db, 'freelist_count')
    if (before === 0) {
      return false
    }
    db.pragma(`incremental_vacuum(${VACUUM_PAGES})`)
    const after = journalPragmaNumber(db, 'freelist_count')
    return after > 0 && after < before
  }
}
