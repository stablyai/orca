import { createHash, randomUUID } from 'node:crypto'
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
      CREATE TABLE IF NOT EXISTS reply_files(account TEXT NOT NULL,mid TEXT NOT NULL,name TEXT NOT NULL,bytes BLOB,sha256 TEXT,file_key TEXT,posted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account,mid),FOREIGN KEY(account,mid) REFERENCES inbox(account,mid) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS review_feishu_messages ON inbox(account) WHERE review=1;`)
    if (
      !this.db
        .prepare('PRAGMA table_info(reply_files)')
        .all()
        .some((c) => c.name === 'sha256')
    ) {
      this.db.exec('ALTER TABLE reply_files ADD COLUMN sha256 TEXT')
    }
    const columns = this.db.prepare('PRAGMA table_info(inbox)').all()
    if (!columns.some((c) => c.name === 'progress')) {
      this.db.exec('ALTER TABLE inbox ADD COLUMN progress INTEGER NOT NULL DEFAULT 0')
    }
    if (!columns.some((c) => c.name === 'kind')) {
      this.db.exec("ALTER TABLE inbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'")
    }
    if (!columns.some((c) => c.name === 'stored_path')) {
      this.db.exec('ALTER TABLE inbox ADD COLUMN stored_path TEXT')
    }
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
      .prepare('INSERT OR IGNORE INTO inbox(account,mid,event,body,kind) VALUES(?,?,?,?,?)')
      .run(b.account, m.message_id, m.event_id, m.content, m.message_type)
  }
  next(account: string) {
    const row = this.db
      .prepare(
        'SELECT mid,body,kind,stored_path AS path FROM inbox WHERE account=? AND body IS NOT NULL AND review=0 ORDER BY rowid LIMIT 1'
      )
      .get(account)
    return (
      row &&
      z
        .object({
          mid: z.string(),
          body: z.string(),
          kind: z.enum(['text', 'image', 'file']),
          path: z.string().nullable()
        })
        .parse(row)
    )
  }
  stored(account: string, mid: string, path: string): void {
    this.db
      .prepare('UPDATE inbox SET stored_path=? WHERE account=? AND mid=? AND body IS NOT NULL')
      .run(path, account, mid)
  }
  stageFile(account: string, mid: string, name: string, bytes: Uint8Array): void {
    const row = this.db
      .prepare('SELECT name,bytes,sha256 FROM reply_files WHERE account=? AND mid=?')
      .get(account, mid)
    if (row) {
      const sameBytes =
        row.bytes instanceof Uint8Array
          ? Buffer.from(row.bytes).equals(bytes)
          : row.sha256 === createHash('sha256').update(bytes).digest('hex')
      if (row.name === name && sameBytes) {
        return
      }
      throw new Error('A different or unverifiable file is already staged for this delivery')
    }
    this.db
      .prepare('INSERT INTO reply_files(account,mid,name,bytes) VALUES(?,?,?,?)')
      .run(account, mid, name, bytes)
  }
  artifact(account: string, mid: string) {
    const row = this.db
      .prepare(
        'SELECT name,bytes,file_key AS key,posted FROM reply_files WHERE account=? AND mid=?'
      )
      .get(account, mid)
    return (
      row &&
      z
        .object({
          name: z.string(),
          bytes: z.instanceof(Uint8Array).nullable(),
          key: z.string().nullable(),
          posted: z.number()
        })
        .parse(row)
    )
  }
  uploaded(account: string, mid: string, key: string): void {
    const row = this.db
      .prepare('SELECT bytes FROM reply_files WHERE account=? AND mid=?')
      .get(account, mid)
    if (row?.bytes instanceof Uint8Array) {
      const digest = createHash('sha256').update(row.bytes).digest('hex')
      this.db
        .prepare(
          'UPDATE reply_files SET file_key=?,sha256=?,bytes=NULL WHERE account=? AND mid=? AND file_key IS NULL'
        )
        .run(key, digest, account, mid)
    }
  }
  filePosted(account: string, mid: string): void {
    this.db.prepare('UPDATE reply_files SET posted=1 WHERE account=? AND mid=?').run(account, mid)
  }
  takeProgress(account: string, mid: string): boolean {
    return Boolean(
      this.db
        .prepare('UPDATE inbox SET progress=1 WHERE account=? AND mid=? AND progress=0')
        .run(account, mid).changes
    )
  }
  admitted(account: string, mid: string): void {
    this.db
      .prepare('UPDATE inbox SET body=NULL,stored_path=NULL WHERE account=? AND mid=?')
      .run(account, mid)
  }
  review(account: string, mid: string): boolean {
    return !!this.db
      .prepare('UPDATE inbox SET review=1 WHERE account=? AND mid=? AND review=0')
      .run(account, mid).changes
  }
  needsReview(account: string): boolean {
    return Boolean(
      this.db.prepare('SELECT 1 FROM inbox WHERE account=? AND review=1 LIMIT 1').get(account)
    )
  }
  /** A reply whose outcome was lost must only be retried within Feishu's one-hour UUID window. */
  postWindowStart(account: string, mid: string, now: number): number | null {
    this.db
      .prepare('UPDATE inbox SET first_post=? WHERE account=? AND mid=? AND first_post IS NULL')
      .run(now, account, mid)
    const row = this.db
      .prepare('SELECT first_post,review FROM inbox WHERE account=? AND mid=?')
      .get(account, mid)
    return row && !row.review && typeof row.first_post === 'number' ? row.first_post : null
  }
}
