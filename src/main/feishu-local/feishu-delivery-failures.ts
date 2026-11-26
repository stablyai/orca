import type Database from '../sqlite/sync-database'

export class FeishuDeliveryFailures {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS feishu_delivery_failures(
      account TEXT NOT NULL REFERENCES bindings(account) ON DELETE CASCADE,
      id TEXT NOT NULL, code INTEGER, attempts INTEGER NOT NULL,
      failed_at INTEGER NOT NULL, retry_at INTEGER,
      PRIMARY KEY(account,id));`)
  }
  ready(account: string, id: string, now: number): boolean {
    const row = this.db
      .prepare('SELECT retry_at FROM feishu_delivery_failures WHERE account=? AND id=?')
      .get(account, id)
    return !row || (typeof row.retry_at === 'number' && row.retry_at <= now)
  }
  failed(account: string, id: string, code: number | null, now: number): void {
    const retry = code === 230011 || code === 231003 ? null : now + 15_000
    this.db
      .prepare(`INSERT INTO feishu_delivery_failures(account,id,code,attempts,failed_at,retry_at)
        VALUES(?,?,?,1,?,?) ON CONFLICT(account,id) DO UPDATE SET
        code=excluded.code,attempts=attempts+1,failed_at=excluded.failed_at,retry_at=excluded.retry_at`)
      .run(account, id, code, now, retry)
  }
  succeeded(account: string, id: string): void {
    this.db
      .prepare('DELETE FROM feishu_delivery_failures WHERE account=? AND id=?')
      .run(account, id)
  }
  retrying(account: string): boolean {
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 FROM feishu_delivery_failures WHERE account=? AND retry_at IS NOT NULL LIMIT 1'
        )
        .get(account)
    )
  }
  needsReview(account: string): boolean {
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 FROM feishu_delivery_failures WHERE account=? AND retry_at IS NULL LIMIT 1'
        )
        .get(account)
    )
  }
}
