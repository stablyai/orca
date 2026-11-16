import { randomUUID } from 'node:crypto'
import type Database from '../../../sqlite/sync-database'
import type { WorkerDockPresence } from '../../../../shared/agent-session/agent-session-background-task-wire'
import { workerDockEligibleSql } from './worker-dock-eligibility'

/** A source hint rides the existing chat stream; empty chats never open a dock stream. */
export class WorkerDockSourcePresence {
  private readonly epoch = randomUUID()
  private sequence = 0
  private readonly known = new Set<string>()
  private readonly changed = new Set<string>()
  private readonly versions = new Map<string, number>()
  private readonly values = new Map<string, WorkerDockPresence | null>()
  private readonly providerSources = new Set<string>()
  private readonly openProviderSources = new Set<string>()

  constructor(private readonly db: Database.Database) {
    for (const row of db
      .prepare(`SELECT DISTINCT source, 0 AS provider FROM worker_dock_facts WHERE source IS NOT NULL
        UNION SELECT DISTINCT source, 1 AS provider FROM worker_dock_provider_failures`)
      .all()) {
      if (typeof row.source === 'string') {
        if (row.provider === 1) {
          this.providerSources.add(row.source)
          this.openProviderSources.add(row.source)
        }
        this.invalidate(row.source, true)
      }
    }
    db.function('worker_dock_source_changed', (source, membership) => {
      if (typeof source === 'string') {
        this.invalidate(source, membership === 1)
      }
      return null
    })
    db.function('worker_dock_provider_failed', (source) => {
      if (typeof source === 'string') {
        this.providerSources.add(source)
        this.openProviderSources.add(source)
        this.invalidate(source, true)
      }
      return null
    })
    db.function('worker_dock_provider_ack_changed', (source) => {
      if (typeof source === 'string' && this.providerSources.has(source)) {
        this.openProviderSources.add(source)
      }
      return null
    })
    db.exec(`CREATE TEMP TRIGGER worker_dock_provider_failed AFTER INSERT ON main.worker_dock_provider_failures BEGIN
      SELECT worker_dock_provider_failed(NEW.source);
    END;`)
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const source = event === 'DELETE' ? 'OLD' : 'NEW'
      const membership =
        event === 'UPDATE'
          ? `(OLD.source IS NOT NEW.source OR (OLD.state = 'succeeded' AND OLD.report_id IS NOT NULL) <> (NEW.state = 'succeeded' AND NEW.report_id IS NOT NULL))`
          : '1'
      db.exec(`CREATE TEMP TRIGGER worker_dock_source_facts_${event} AFTER ${event} ON main.worker_dock_facts BEGIN
        SELECT worker_dock_source_changed(${source}.source, ${membership});
        ${event === 'UPDATE' ? 'SELECT worker_dock_source_changed(OLD.source, 1) WHERE OLD.source IS NOT NEW.source;' : ''}
      END;`)
      for (const table of ['worker_dock_acknowledgments', 'worker_dock_owner_stops']) {
        db.exec(`CREATE TEMP TRIGGER worker_dock_source_${table}_${event} AFTER ${event} ON main.${table} BEGIN
          SELECT worker_dock_source_changed(${source}.source, 1);
          ${table === 'worker_dock_acknowledgments' ? `SELECT worker_dock_provider_ack_changed(${source}.source);` : ''}
        END;`)
      }
      db.exec(`CREATE TEMP TRIGGER worker_dock_source_activity_${event} AFTER ${event} ON main.worker_dock_activity BEGIN
        SELECT worker_dock_source_changed(source, 0) FROM worker_dock_facts WHERE dispatch_id = ${source}.dispatch_id;
      END;`)
    }
  }

  private invalidate(source: string, membership: boolean): void {
    this.known.add(source)
    this.versions.set(source, ++this.sequence)
    if (membership) {
      this.dirty.add(source)
      this.changed.add(source)
    }
  }

  version(source: string): number {
    return this.versions.get(source) ?? 0
  }

  hasProviderFailures(source: string): boolean {
    return this.openProviderSources.has(source)
  }

  rememberNoProviderFailures(source: string): void {
    this.openProviderSources.delete(source)
  }

  get hasChanges(): boolean {
    return this.changed.size > 0
  }

  rememberEmpty(source: string): void {
    const previous = this.values.get(source)
    if (previous?.open) {
      this.values.set(source, { ...previous, open: false })
    }
  }

  changedSources(): readonly string[] {
    const sources = [...this.changed]
    for (const source of sources) {
      // Keep the old hint to avoid publishing a new chat frame while membership stays open.
      this.dirty.add(source)
    }
    this.changed.clear()
    return sources
  }

  private readonly dirty = new Set<string>()
  read(source: string): WorkerDockPresence | undefined {
    if (!this.known.has(source)) {
      return undefined
    }
    const previous = this.values.get(source)
    if (this.db.isTransaction) {
      return previous ?? undefined
    }
    if (this.values.has(source) && !this.dirty.has(source)) {
      return previous ?? undefined
    }
    const row = this.db
      .prepare(`SELECT
      EXISTS(SELECT 1 FROM worker_dock_facts f WHERE f.source = ?) AS history,
      EXISTS(SELECT 1 FROM worker_dock_facts f INDEXED BY worker_dock_eligible WHERE ${workerDockEligibleSql}) AS open`)
      .get(source, source)
    const providerOpen =
      this.openProviderSources.has(source) &&
      this.db
        .prepare(`SELECT 1
      FROM worker_dock_provider_failures f WHERE f.source = ? AND NOT EXISTS (
        SELECT 1 FROM worker_dock_acknowledgments a WHERE a.source = f.source
          AND a.dispatch_id = f.id AND a.settlement = f.settlement) LIMIT 1`)
        .get(source)
    if (!providerOpen) {
      this.openProviderSources.delete(source)
    }
    const open = row?.open === 1 || Boolean(providerOpen)
    const next =
      row?.history !== 1 && !this.providerSources.has(source)
        ? null
        : open && previous?.open
          ? previous
          : { revision: `${this.epoch}:${this.version(source)}`, open }
    this.values.set(source, next)
    this.dirty.delete(source)
    return next ?? undefined
  }
}
