import type Database from '../sqlite/sync-database'

/** Display destinations only; Orca's conversation-report provenance authorizes the reply. */
export class FeishuWorkerResponses {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS feishu_worker_responses(
      account TEXT NOT NULL REFERENCES bindings(account) ON DELETE CASCADE,
      external TEXT NOT NULL, worker TEXT NOT NULL, original TEXT NOT NULL,
      PRIMARY KEY(account,external,worker,original));`)
  }
  remember(account: string, external: string, original: string, workers: readonly string[]) {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO feishu_worker_responses(account,external,worker,original) VALUES(?,?,?,?)'
    )
    for (const worker of workers) {
      insert.run(account, external, worker, original)
    }
  }
  destination(account: string, external: string, workers: readonly string[]): string | null {
    const originals = new Set<string>()
    for (const worker of workers) {
      const rows = this.db
        .prepare(
          'SELECT original FROM feishu_worker_responses WHERE account=? AND external=? AND worker=?'
        )
        .all(account, external, worker)
      if (rows.length !== 1) {
        return null
      }
      originals.add(String(rows[0]!.original))
    }
    return originals.size === 1 ? [...originals][0]! : null
  }
}
