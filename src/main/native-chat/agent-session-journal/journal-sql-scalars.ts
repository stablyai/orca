import type { JournalSqlScope } from './journal-sql-scope'

export function journalSqlScalarSchema(): string {
  return `
CREATE TABLE IF NOT EXISTS journal_proj_scalars (
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY (session_id, generation, owner, name)
) WITHOUT ROWID;
`
}

/** Fixed-size facts: read once per command on first use, written through on every change. */
export class JournalSqlScalars {
  private readonly cache = new Map<string, unknown>()

  constructor(
    private readonly scope: JournalSqlScope,
    private readonly owner: string
  ) {}

  get<T>(name: string, fallback: T): T {
    if (!this.cache.has(name)) {
      const row = this.scope.db
        .prepare(`SELECT value_json FROM journal_proj_scalars
        WHERE session_id=? AND generation=? AND owner=? AND name=?`)
        .get(...this.scope.prefix, this.owner, name)
      this.cache.set(
        name,
        row ? this.scope.decode<T>(this.scope.examined(row).value_json) : fallback
      )
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each owner reads back the typed value it stored under that name.
    return this.cache.get(name) as T
  }

  set(name: string, value: unknown): void {
    this.cache.set(name, value)
    this.scope.db
      .prepare(`INSERT INTO journal_proj_scalars (session_id, generation, owner, name, value_json)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, generation, owner, name)
      DO UPDATE SET value_json=excluded.value_json`)
      .run(...this.scope.prefix, this.owner, name, JSON.stringify(value ?? null))
  }

  /** Defines accessor properties so reducer code keeps its plain field reads and writes. */
  define<T extends object, S extends object>(target: T, defaults: S): T & S {
    for (const [name, fallback] of Object.entries(defaults)) {
      Object.defineProperty(target, name, {
        enumerable: true,
        get: () => this.get(name, fallback),
        set: (value: unknown) => {
          this.set(name, value)
        }
      })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every key of defaults was just defined on target as an accessor of its type.
    return target as T & S
  }
}
