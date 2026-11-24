import type Database from '../../sqlite/sync-database'

export class PipelineCreationJournal<T> {
  constructor(
    private readonly db: Database.Database,
    private readonly table: 'pipeline_creations' | 'pipeline_creations_v2',
    private readonly digest: (value: unknown) => string,
    private readonly getRun: (id: string) => T,
    private readonly beforeReserve?: () => void
  ) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, digest TEXT NOT NULL, run_id TEXT, data TEXT)`
    )
  }
  reserve(id: string, input: unknown, snapshot?: unknown): { fresh: boolean; run?: T } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.creation(id, input)
      if (previous) {
        this.db.exec('COMMIT')
        return previous
      }
      this.beforeReserve?.()
      const result = this.insert(id, input, snapshot)
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  private insert(id: string, input: unknown, snapshot?: unknown): { fresh: boolean; run?: T } {
    const digest = this.digest(input)
    const inserted = this.db
      .prepare(`INSERT OR IGNORE INTO ${this.table} (id,digest,data) VALUES (?,?,?)`)
      .run(id, digest, snapshot ? JSON.stringify(snapshot) : null)
    const row = this.db.prepare(`SELECT digest,run_id FROM ${this.table} WHERE id=?`).get(id)!
    if (row.digest !== digest) {
      throw new Error('pipeline_request_conflict')
    }
    return {
      fresh: inserted.changes === 1,
      ...(typeof row.run_id === 'string' ? { run: this.getRun(row.run_id) } : {})
    }
  }
  creation(id: string, input: unknown): { fresh: false; run?: T } | undefined {
    const row = this.db.prepare(`SELECT digest,run_id FROM ${this.table} WHERE id=?`).get(id)
    if (!row) {
      return undefined
    }
    if (row.digest !== this.digest(input)) {
      throw new Error('pipeline_request_conflict')
    }
    return {
      fresh: false,
      ...(typeof row.run_id === 'string' ? { run: this.getRun(row.run_id) } : {})
    }
  }
  snapshot(id: string): unknown {
    const row = this.db.prepare(`SELECT data FROM ${this.table} WHERE id=?`).get(id)
    if (typeof row?.data !== 'string') {
      throw new Error('pipeline_creation_snapshot_missing')
    }
    return JSON.parse(row.data)
  }
  complete(id: string, runId: string): void {
    this.db
      .prepare(`UPDATE ${this.table} SET run_id=? WHERE id=? AND (run_id IS NULL OR run_id=?)`)
      .run(runId, id, runId)
  }
}
