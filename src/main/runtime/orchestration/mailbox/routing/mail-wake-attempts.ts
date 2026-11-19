import { randomUUID } from 'node:crypto'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { RuntimePtyWorktreeRecord } from '../../../terminal/records/runtime-terminal-state-records'
import type { SleptMailRecord } from './mail-wake-obligation'

type Deps = {
  db: () => OrchestrationDb | null
  pty: (paneKey: string) => RuntimePtyWorktreeRecord | null
}

/** Main's mail-wake attempts: the orchestration database's rows, mirrored per pane. */
export class MailWakeAttempts {
  private readonly byPane = new Map<string, SleptMailRecord>()
  private loadedFrom: OrchestrationDb | null = null

  constructor(private readonly deps: Deps) {}

  get size(): number {
    return this.byPane.size
  }

  get(paneKey: string): SleptMailRecord | undefined {
    return this.byPane.get(paneKey)
  }

  panes(): string[] {
    return [...this.byPane.keys()]
  }

  records(): SleptMailRecord[] {
    return [...this.byPane.values()]
  }

  launchTokens(): ReadonlySet<string> {
    return new Set(
      this.records().flatMap((record) =>
        record.mailWake?.attempt ? [record.mailWake.attempt.launchToken] : []
      )
    )
  }

  /** Reads the rows once per database; a claim that never got a process cannot still be launching. */
  load(): void {
    const db = this.deps.db()
    if (!db || this.loadedFrom === db) {
      return
    }
    this.loadedFrom = db
    this.byPane.clear()
    for (const attempt of db.listMailWakeAttempts()) {
      if (attempt.mailWake && !attempt.mailWake.attempt) {
        db.settleMailWake(attempt.paneKey, attempt.mailWake.id)
      } else {
        this.byPane.set(attempt.paneKey, attempt)
      }
    }
  }

  /** Null when the pane already has an attempt or there is no database. */
  claim(record: SleptMailRecord): SleptMailRecord | null {
    const db = this.deps.db()
    this.load()
    const id = randomUUID()
    const startedAt = Date.now()
    if (!db || !db.claimMailWake(record, id, startedAt)) {
      return null
    }
    const claimed = { ...record, mailWake: { id, startedAt } }
    this.byPane.set(record.paneKey, claimed)
    return claimed
  }

  /** The first process in the pane after its claim is the one the wake launched. */
  stampLaunch(record: SleptMailRecord): SleptMailRecord {
    const marker = record.mailWake
    const pty = this.deps.pty(record.paneKey)
    const db = this.deps.db()
    if (
      !db ||
      !marker ||
      marker.attempt ||
      pty?.connected !== true ||
      pty.worktreeId !== record.worktreeId ||
      pty.connectionId !== (record.connectionId ?? null) ||
      !pty.incarnationId ||
      !pty.launchToken
    ) {
      return record
    }
    const attempt = {
      ptyId: pty.ptyId,
      incarnationId: pty.incarnationId,
      launchToken: pty.launchToken,
      startedAt: marker.startedAt
    }
    if (!db.recordMailWakeLaunch(record.paneKey, marker.id, attempt)) {
      return record
    }
    const launched = { ...record, mailWake: { ...marker, attempt } }
    this.byPane.set(record.paneKey, launched)
    return launched
  }

  /** True when this call removed the pane's current attempt. */
  settle(record: SleptMailRecord): boolean {
    const marker = record.mailWake
    if (!marker || this.byPane.get(record.paneKey)?.mailWake?.id !== marker.id) {
      return false
    }
    this.byPane.delete(record.paneKey)
    this.deps.db()?.settleMailWake(record.paneKey, marker.id)
    return true
  }
}
