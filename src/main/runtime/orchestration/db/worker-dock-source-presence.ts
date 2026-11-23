import { randomUUID } from 'node:crypto'
import type Database from '../../../sqlite/sync-database'
import type { WorkerDockPresence } from '../../../../shared/agent-session/background-tasks/agent-session-background-task-wire'
import type { WorkerDockSnapshot } from '../../../../shared/orchestration/dock/worker-dock'
import type { DispatchContextRow, RunRow } from './orchestration-records'

const sources = new WeakMap<Database.Database, WorkerDockSourcePresence>()
export function workerDockSourcesFor(db: Database.Database) {
  return sources.get(db)
}

/** Presence and invalidation use existing write receipts; this class never reads SQLite. */
export class WorkerDockSourcePresence {
  private readonly epoch = randomUUID()
  private sequence = 0
  private readonly changed = new Set<string>()
  private readonly versions = new Map<string, number>()
  private readonly values = new Map<string, WorkerDockPresence>()
  private readonly seeded = new Set<string>()
  private readonly providerSources = new Set<string>()
  private listener: (() => void) | undefined
  private readonly dispatchSources = new Map<string, string>()
  private readonly fallbackByRun = new Map<string, Set<string>>()
  private readonly runs = new Map<string, string | null>()

  constructor(db: Database.Database) {
    sources.set(db, this)
  }

  watch(listener: () => void): () => void {
    this.listener = listener
    return () => {
      if (this.listener === listener) {
        this.listener = undefined
      }
    }
  }

  needsSeed(source: string): boolean {
    return !this.seeded.has(source)
  }

  rememberDispatch(row: DispatchContextRow | undefined): void {
    if (!row) {
      return
    }
    if (!row.creator_orca_session_id && !row.creator_dispatch_id) {
      let fallback = this.fallbackByRun.get(row.run_id)
      if (!fallback) {
        fallback = new Set()
        this.fallbackByRun.set(row.run_id, fallback)
      }
      fallback.add(row.id)
    } else {
      this.fallbackByRun.get(row.run_id)?.delete(row.id)
    }
    const source =
      row.creator_orca_session_id ??
      (row.creator_dispatch_id === null ? this.runs.get(row.run_id) : null)
    if (source) {
      this.dispatchSources.set(row.id, source)
    }
  }

  rememberRun(row: RunRow | undefined): void {
    if (!row) {
      return
    }
    const previous = this.runs.get(row.id)
    const source = row.coordinator_orca_session_id
    this.runs.set(row.id, source)
    if (previous === source) {
      return
    }
    for (const id of this.fallbackByRun.get(row.id) ?? []) {
      const before = this.dispatchSources.get(id)
      if (source) {
        this.dispatchSources.set(id, source)
      } else {
        this.dispatchSources.delete(id)
      }
      if (before) {
        this.invalidate(before)
      }
      if (source) {
        this.invalidate(source)
      }
    }
  }

  changedDispatch(id: string): void {
    const source = this.dispatchSources.get(id)
    if (source) {
      this.invalidate(source)
    }
  }

  forgetWorkers(): void {
    this.changedHistory()
    this.dispatchSources.clear()
    this.fallbackByRun.clear()
  }

  changedHistory(): void {
    for (const source of this.values.keys()) {
      this.invalidate(source)
    }
  }

  invalidate(source: string, membership = true): void {
    this.versions.set(source, ++this.sequence)
    if (membership) {
      const previous = this.values.get(source)
      this.values.set(
        source,
        previous?.open ? previous : { revision: `${this.epoch}:${this.sequence}`, open: true }
      )
      this.changed.add(source)
      this.listener?.()
    }
  }

  rememberSnapshot(source: string, snapshot: WorkerDockSnapshot, providerFailures: boolean): void {
    const first = !this.seeded.has(source)
    if (first) {
      this.seeded.add(source)
    }
    const open = snapshot.identities.length > 0
    const previous = this.values.get(source)
    if (open || snapshot.results.length || previous) {
      const next =
        previous?.open === open
          ? previous
          : { revision: `${this.epoch}:${this.version(source)}`, open }
      if (next !== previous) {
        this.values.set(source, next)
        this.changed.add(source)
        this.listener?.()
      }
    }
    if (first) {
      for (const row of snapshot.identities) {
        this.dispatchSources.set(row.dispatchId, source)
      }
      for (const row of snapshot.results) {
        this.dispatchSources.set(row.dispatchId, source)
      }
    }
    if (providerFailures) {
      this.providerSources.add(source)
    }
  }

  version(source: string): number {
    return this.versions.get(source) ?? 0
  }

  hasProviderFailures(source: string): boolean {
    return !this.seeded.has(source) || this.providerSources.has(source)
  }

  providerFailed(source: string): void {
    this.providerSources.add(source)
    this.invalidate(source)
  }

  acknowledgmentChanged(source: string, restoring: boolean): void {
    if (restoring) {
      this.providerSources.add(source)
    }
    this.invalidate(source)
  }

  rememberNoProviderFailures(source: string): void {
    this.providerSources.delete(source)
  }

  get hasChanges(): boolean {
    return this.changed.size > 0
  }

  changedSources(): readonly string[] {
    const changed = [...this.changed]
    this.changed.clear()
    return changed
  }

  read(source: string): WorkerDockPresence | undefined {
    return this.values.get(source)
  }
}
