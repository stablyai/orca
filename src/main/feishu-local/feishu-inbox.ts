import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import Database from '../sqlite/sync-database'
import type { FeishuMessage, FeishuProfile } from './feishu-cli'
import { FeishuCardStore } from './feishu-card-store'
import type { FeishuCardData } from './feishu-card-data'
import { FeishuRoutes } from './feishu-routes'
import type { FeishuRoute } from './feishu-route-key'
import { binding, type Binding } from './feishu-binding'

const inReplyWindow = (first: number, now: number): boolean =>
  now >= first && now - first < 55 * 60_000

/** One database per installation. A CLI app can belong to just one Orca profile and bot. */
export class FeishuInbox {
  private db: Database.Database
  private cards: FeishuCardStore
  private routes: FeishuRoutes
  constructor(path: string) {
    this.db = new Database(path)
    this.db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS bindings(account TEXT PRIMARY KEY, scope TEXT NOT NULL,bot TEXT NOT NULL,profile TEXT NOT NULL,app TEXT NOT NULL UNIQUE,owner TEXT,chat TEXT,pairedAt INTEGER,UNIQUE(scope,bot));
      CREATE TABLE IF NOT EXISTS inbox(account TEXT NOT NULL REFERENCES bindings(account) ON DELETE CASCADE,mid TEXT NOT NULL,event TEXT NOT NULL,body TEXT,first_post INTEGER,review INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account,mid),UNIQUE(account,event));
      CREATE INDEX IF NOT EXISTS pending_feishu_messages ON inbox(account) WHERE body IS NOT NULL AND review=0;
      CREATE TABLE IF NOT EXISTS reply_files(account TEXT NOT NULL,mid TEXT NOT NULL,name TEXT NOT NULL,bytes BLOB,file_key TEXT,posted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account,mid),FOREIGN KEY(account,mid) REFERENCES inbox(account,mid) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS text_replies(account TEXT NOT NULL,id TEXT NOT NULL,mid TEXT NOT NULL,text TEXT NOT NULL,first_post INTEGER,message_id TEXT,review INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account,id),FOREIGN KEY(account,mid) REFERENCES inbox(account,mid) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS pending_feishu_replies ON text_replies(account) WHERE message_id IS NULL AND review=0;
      CREATE INDEX IF NOT EXISTS review_feishu_messages ON inbox(account) WHERE review=1;`)
    this.cards = new FeishuCardStore(this.db)
    this.routes = new FeishuRoutes(this.db)
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
  putRoute(account: string, mid: string, route: FeishuRoute) {
    this.routes.put(account, mid, route)
  }
  messageRoute(account: string, mid: string) {
    return this.routes.message(account, mid)
  }
  laneRoute(account: string, external: string) {
    return this.routes.lane(account, external)
  }
  putCard(
    account: string,
    id: string,
    external: string,
    original: string,
    chat: string,
    data: FeishuCardData
  ) {
    this.cards.put(account, id, external, original, chat, data)
  }
  pendingChoice(account: string, original: string) {
    return this.cards.pendingChoice(account, original)
  }
  pendingCards(account: string) {
    return this.cards.pending(account)
  }
  claimCard(account: string, message: string, chat: string, option: string) {
    return this.cards.claim(account, message, chat, option)
  }
  closeCard = (...args: Parameters<FeishuCardStore['close']>) => this.cards.close(...args)
  closePrompts(
    account: string,
    external: string,
    keep: string | null,
    note: string,
    kind: 'prompt' | 'async-question' = 'prompt'
  ) {
    this.cards.closePrompts(account, external, keep, note, kind)
  }
  sendingCard(account: string, id: string, now: number) {
    return this.cards.sending(account, id, now)
  }
  postedCard(account: string, id: string, revision: number, message: string) {
    this.cards.posted(account, id, revision, message)
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
      (m.chat_id !== b.chat && !this.routes.message(b.account, m.message_id)) ||
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
      .prepare('SELECT name,bytes FROM reply_files WHERE account=? AND mid=?')
      .get(account, mid)
    if (
      row &&
      row.name === name &&
      row.bytes instanceof Uint8Array &&
      Buffer.from(row.bytes).equals(bytes)
    ) {
      return
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
    this.db
      .prepare('UPDATE reply_files SET file_key=?,bytes=NULL WHERE account=? AND mid=?')
      .run(key, account, mid)
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
  queueReply(account: string, mid: string, id: string, text: string) {
    const row = this.db
      .prepare('SELECT mid,text,message_id,review FROM text_replies WHERE account=? AND id=?')
      .get(account, id)
    if (row) {
      if (row.mid !== mid || row.text !== text || row.review) {
        throw new Error('The Feishu reply id was reused or needs review')
      }
      return typeof row.message_id === 'string'
        ? { status: 'posted' as const, messageId: row.message_id }
        : { status: 'queued' as const }
    }
    this.db
      .prepare('INSERT INTO text_replies(account,mid,id,text) VALUES(?,?,?,?)')
      .run(account, mid, id, text)
    return { status: 'queued' as const }
  }
  pendingReplies(account: string) {
    return this.db
      .prepare(
        'SELECT id,mid,text FROM text_replies WHERE account=? AND message_id IS NULL AND review=0 ORDER BY rowid LIMIT 32'
      )
      .all(account)
      .map((row) => z.object({ id: z.string(), mid: z.string(), text: z.string() }).parse(row))
  }
  mayPostReply(account: string, id: string, now: number): boolean {
    this.db
      .prepare(
        'UPDATE text_replies SET first_post=? WHERE account=? AND id=? AND first_post IS NULL'
      )
      .run(now, account, id)
    const row = this.db
      .prepare('SELECT first_post,message_id,review FROM text_replies WHERE account=? AND id=?')
      .get(account, id)
    if (!row || row.message_id || row.review || typeof row.first_post !== 'number') {
      return false
    }
    if (!inReplyWindow(row.first_post, now)) {
      this.db.prepare('UPDATE text_replies SET review=1 WHERE account=? AND id=?').run(account, id)
      return false
    }
    return true
  }
  replyPosted(account: string, id: string, messageId: string): void {
    this.db
      .prepare(
        'UPDATE text_replies SET message_id=? WHERE account=? AND id=? AND message_id IS NULL'
      )
      .run(messageId, account, id)
  }
  review(account: string, mid: string): void {
    this.db.prepare('UPDATE inbox SET review=1 WHERE account=? AND mid=?').run(account, mid)
  }
  needsReview(account: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM feishu_cards WHERE account=? AND review=1 LIMIT 1')
        .get(account) ||
      this.db.prepare('SELECT 1 FROM inbox WHERE account=? AND review=1 LIMIT 1').get(account) ||
      this.db
        .prepare('SELECT 1 FROM text_replies WHERE account=? AND review=1 LIMIT 1')
        .get(account)
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
      inReplyWindow(row.first_post, now)
    )
  }
}
