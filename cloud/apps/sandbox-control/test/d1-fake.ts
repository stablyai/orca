// A D1Database over node:sqlite for tests: same SQL dialect (SQLite), same prepare/bind/first/
// all/run/batch surface, batch() in one transaction like D1.
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

type Param = string | number | null

class FakeStatement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: Param[] = []
  ) {}

  bind(...params: unknown[]): FakeStatement {
    for (const param of params) {
      if (param === undefined || typeof param === 'boolean' || typeof param === 'object' && param !== null) {
        throw new Error(`D1 cannot bind ${typeof param}`)
      }
    }
    return new FakeStatement(this.db, this.sql, params as Param[])
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: { changes: number } }> {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[], success: true, meta: { changes: 0 } }
  }

  runSync(): { success: true; meta: { changes: number } } {
    const result = this.db.prepare(this.sql).run(...this.params)
    return { success: true, meta: { changes: Number(result.changes) } }
  }

  async run() {
    return this.runSync()
  }
}

export function createFakeD1(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:')
  const dir = fileURLToPath(new URL('../migrations/', import.meta.url).href)
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`${dir}${file}`, 'utf8'))
  }
  const db = {
    prepare: (sql: string) => new FakeStatement(raw, sql),
    async batch(statements: FakeStatement[]) {
      raw.exec('BEGIN')
      try {
        const results = statements.map((statement) => statement.runSync())
        raw.exec('COMMIT')
        return results
      } catch (error) {
        raw.exec('ROLLBACK')
        throw error
      }
    }
  }
  return { db: db as unknown as D1Database, raw }
}
