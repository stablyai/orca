import { z } from 'zod'
import type Database from '../sqlite/sync-database'
import { feishuRoute, type FeishuRoute } from './feishu-route-key'
export class FeishuRoutes {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS feishu_routes(account TEXT NOT NULL REFERENCES bindings(account) ON DELETE CASCADE,
      mid TEXT NOT NULL,external TEXT NOT NULL,chat TEXT NOT NULL,root TEXT NOT NULL,original TEXT NOT NULL,is_group INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(account,mid)); CREATE INDEX IF NOT EXISTS feishu_lanes ON feishu_routes(account,external);`)
  }
  put(account: string, mid: string, route: FeishuRoute) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO feishu_routes(account,mid,external,chat,root,original,is_group) VALUES(?,?,?,?,?,?,?)'
      )
      .run(
        account,
        mid,
        route.external,
        route.chat,
        route.root,
        route.original,
        Number(route.group)
      )
  }
  message(account: string, mid: string) {
    return this.read(
      this.db.prepare('SELECT * FROM feishu_routes WHERE account=? AND mid=?').get(account, mid)
    )
  }
  lane(account: string, external: string) {
    return this.read(
      this.db
        .prepare(
          'SELECT * FROM feishu_routes WHERE account=? AND external=? ORDER BY rowid DESC LIMIT 1'
        )
        .get(account, external)
    )
  }
  private read(row: unknown) {
    if (!row) {
      return null
    }
    const found = z
      .object({
        external: z.string(),
        chat: z.string(),
        root: z.string(),
        original: z.string(),
        is_group: z.number()
      })
      .parse(row)
    return feishuRoute.parse({ ...found, group: Boolean(found.is_group) })
  }
}
