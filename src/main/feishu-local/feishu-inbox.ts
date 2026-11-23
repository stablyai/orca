import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import Database from '../sqlite/sync-database'
import type { FeishuMessage, FeishuProfile } from './feishu-cli'
import { binding, type Binding } from './feishu-binding'
/** One database per installation. A CLI app can belong to just one Orca profile and bot. */
export class FeishuInbox {
  private db: Database.Database
  constructor(path: string) {
    this.db = new Database(path)
    this.db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS bindings(account TEXT PRIMARY KEY, scope TEXT NOT NULL,bot TEXT NOT NULL,profile TEXT NOT NULL,app TEXT NOT NULL UNIQUE,owner TEXT,chat TEXT,pairedAt INTEGER,UNIQUE(scope,bot));
      CREATE TABLE IF NOT EXISTS inbox(account TEXT NOT NULL REFERENCES bindings(account) ON DELETE CASCADE,mid TEXT NOT NULL,event TEXT NOT NULL,body TEXT,first_post INTEGER,review INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account,mid),UNIQUE(account,event));
      CREATE INDEX IF NOT EXISTS pending_feishu_messages ON inbox(account) WHERE body IS NOT NULL AND review=0;
      CREATE INDEX IF NOT EXISTS review_feishu_messages ON inbox(account) WHERE review=1;`)
  }
  close(): void {
    this.db.close()
  }
  bindings(scope: string): Binding[] {
    return this.db
      .prepare('SELECT account,bot,profile,app,owner,chat,pairedAt FROM bindings WHERE scope=?')
      .all(scope)
      .map((row) => binding.parse(row))
  }
  add(scope: string, bot: string, p: FeishuProfile): Binding {
    const b = {
      account: `local-feishu/${randomUUID()}`,
      bot,
      profile: p.name,
      app: p.appId,
      owner: null,
      chat: null,
      pairedAt: null
    }
    this.db
      .prepare('INSERT INTO bindings(account,scope,bot,profile,app) VALUES(?,?,?,?,?)')
      .run(b.account, scope, bot, p.name, p.appId)
    return b
  }
  remove(scope: string, bot: string, account: string): void {
    this.db
      .prepare('DELETE FROM bindings WHERE scope=? AND bot=? AND account=?')
      .run(scope, bot, account)
  }
  pair(scope: string, b: Binding, m: FeishuMessage): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const { changes } = this.db
        .prepare(
          'UPDATE bindings SET owner=?,chat=?,pairedAt=? WHERE scope=? AND account=? AND owner IS NULL'
        )
        .run(m.sender_id, m.chat_id, Number(m.create_time), scope, b.account)
      if (changes) {
        this.db
          .prepare('INSERT INTO inbox(account,mid,event) VALUES(?,?,?)')
          .run(b.account, m.message_id, m.event_id)
      }
      this.db.exec('COMMIT')
      return Boolean(changes)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  accept(b: Binding, m: FeishuMessage): void {
    if (
      m.sender_id !== b.owner ||
      m.chat_id !== b.chat ||
      b.pairedAt === null ||
      Number(m.create_time) <= b.pairedAt
    ) {
      return
    }
    this.db
      .prepare('INSERT OR IGNORE INTO inbox(account,mid,event,body) VALUES(?,?,?,?)')
      .run(b.account, m.message_id, m.event_id, m.content)
  }
  next(account: string) {
    const row = this.db
      .prepare(
        'SELECT mid,body FROM inbox WHERE account=? AND body IS NOT NULL AND review=0 ORDER BY rowid LIMIT 1'
      )
      .get(account)
    return row && z.object({ mid: z.string(), body: z.string() }).parse(row)
  }
  admitted(account: string, mid: string): void {
    this.db.prepare('UPDATE inbox SET body=NULL WHERE account=? AND mid=?').run(account, mid)
  }
  review(account: string, mid: string): void {
    this.db.prepare('UPDATE inbox SET review=1 WHERE account=? AND mid=?').run(account, mid)
  }
  needsReview(account: string): boolean {
    return Boolean(
      this.db.prepare('SELECT 1 FROM inbox WHERE account=? AND review=1 LIMIT 1').get(account)
    )
  }
  /** A reply whose outcome was lost must only be retried within Feishu's one-hour UUID window. */
  mayPost(account: string, mid: string, now: number): boolean {
    this.db
      .prepare('UPDATE inbox SET first_post=? WHERE account=? AND mid=? AND first_post IS NULL')
      .run(now, account, mid)
    const row = this.db
      .prepare('SELECT first_post,review FROM inbox WHERE account=? AND mid=?')
      .get(account, mid)
    return (
      !!row &&
      !row.review &&
      typeof row.first_post === 'number' &&
      now >= row.first_post &&
      now - row.first_post < 55 * 60_000
    )
  }
}
