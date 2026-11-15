import type Database from '../../../../sqlite/sync-database'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../shared/agent-status/contracts/agent-status-freshness'
import { dispatchCompletionEpoch } from './dispatch-completion-epoch'
import {
  completionTable,
  completionState,
  presentationCompletionSchema
} from './presentation-completion-schema'

type Snapshot = { revision: number; version: number }
const sources = new WeakMap<Database.Database, PresentationCompletionSource>()

/** Normalization belongs to the connection, independently of disposable projection caches. */
class PresentationCompletionSource {
  private installed = false
  private snapshot: Snapshot | undefined

  constructor(private readonly db: Database.Database) {
    db.function('orchestration_completion_epoch', dispatchCompletionEpoch)
    db.function('orchestration_presentation_now', () => Date.now())
  }

  read<T>(now: number, read: (snapshot: Snapshot) => T): T {
    if (this.snapshot) {
      return read(this.snapshot)
    }
    const outer = this.db.isTransaction
    this.db.exec('SAVEPOINT orchestration_presentation_source')
    try {
      this.install()
      // Acquire the main snapshot before observing its data_version, including an empty source.
      this.db.prepare('SELECT rowid FROM main.dispatch_contexts LIMIT 1').get()
      const state = this.db
        .prepare(`SELECT *, (SELECT data_version FROM pragma_data_version) AS current_version
          FROM temp.${completionState} WHERE id = 1`)
        .get()
      if (
        !state ||
        typeof state.current_version !== 'number' ||
        typeof state.revision !== 'number'
      ) {
        throw new Error('Orchestration presentation source is unavailable')
      }
      const zone = `${process.env.TZ ?? ''}|${Intl.DateTimeFormat().resolvedOptions().timeZone}`
      let revision = state.revision
      if (
        state.ready !== 1 ||
        state.recovery === 1 ||
        state.version !== state.current_version ||
        state.zone !== zone ||
        typeof state.stamp !== 'number' ||
        now < state.stamp
      ) {
        this.rebuild(now)
        revision++
        this.db
          .prepare(`UPDATE temp.${completionState} SET ready = 1, version = ?, zone = ?,
            recovery = 0, revision = ? WHERE id = 1`)
          .run(state.current_version, zone, revision)
      }
      this.db
        .prepare(`DELETE FROM temp.${completionTable} WHERE epoch < ?`)
        .run(now - AGENT_STATUS_STALE_AFTER_MS)
      this.db.prepare(`UPDATE temp.${completionState} SET stamp = ? WHERE id = 1`).run(now)
      this.snapshot = { revision, version: state.current_version }
      const result = read(this.snapshot)
      this.db.exec('RELEASE orchestration_presentation_source')
      if (!outer) {
        this.installed = true
      }
      return result
    } catch (error) {
      this.db.exec('ROLLBACK TO orchestration_presentation_source')
      this.db.exec('RELEASE orchestration_presentation_source')
      throw error
    } finally {
      this.snapshot = undefined
    }
  }

  private install(): void {
    if (this.installed) {
      return
    }
    // First initialization inside a caller transaction may have rolled back its TEMP schema.
    if (
      !this.db
        .prepare('SELECT 1 FROM sqlite_temp_master WHERE type = ? AND name = ?')
        .get('table', completionState)
    ) {
      this.db.exec(presentationCompletionSchema)
    }
  }

  private rebuild(now: number): void {
    this.db.prepare(`DELETE FROM temp.${completionTable}`).run()
    const insert = this.db.prepare(`INSERT INTO temp.${completionTable}(id, epoch) VALUES (?, ?)`)
    for (const row of this.db
      .prepare(`SELECT id, completed_at FROM dispatch_contexts
        WHERE status NOT IN ('pending', 'dispatched')`)
      .iterate()) {
      const epoch = dispatchCompletionEpoch(row.completed_at)
      if (epoch !== null && epoch >= now - AGENT_STATUS_STALE_AFTER_MS) {
        insert.run(row.id, epoch)
      }
    }
  }
}

export function withPresentationCompletionSource<T>(
  db: Database.Database,
  now: number,
  read: (snapshot: Snapshot) => T
): T {
  let source = sources.get(db)
  if (!source) {
    source = new PresentationCompletionSource(db)
    sources.set(db, source)
  }
  return source.read(now, read)
}
