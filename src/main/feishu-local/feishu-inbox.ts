import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type Database from '../sqlite/sync-database'
import { openFeishuInboxDatabase } from './feishu-inbox-schema'
import type { FeishuMessage, FeishuProfile } from './feishu-cli'
import { binding, type Binding } from './feishu-binding'
const READABLE = ['text', 'image', 'file', 'post'] as const

function excerptOf(m: FeishuMessage): string {
  if (m.message_type !== 'text' && m.message_type !== 'post') {
    return `[${m.message_type}]`
  }
  const line = m.content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[image]')
    .replace(/\s+/g, ' ')
    .trim()
  return line.length <= 40 ? line : `${line.slice(0, 39).trimEnd()}…`
}

/** One database per installation. A CLI app can belong to just one Orca profile and bot. */
export class FeishuInbox {
  private db: Database.Database
  constructor(path: string) {
    this.db = openFeishuInboxDatabase(path)
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
      .prepare(
        'INSERT OR IGNORE INTO inbox(account,mid,event,body,kind,excerpt) VALUES(?,?,?,?,?,?)'
      )
      .run(b.account, m.message_id, m.event_id, m.content, m.message_type, excerptOf(m))
  }
  next(account: string) {
    const row = this.db
      .prepare(
        'SELECT mid,body,kind,stored_path AS path FROM inbox WHERE account=? AND body IS NOT NULL AND review=0 ORDER BY rowid LIMIT 1'
      )
      .get(account)
    if (!row) {
      return row
    }
    const { kind, ...rest } = z
      .object({ mid: z.string(), body: z.string(), kind: z.string(), path: z.string().nullable() })
      .parse(row)
    const readable = z.enum(READABLE).safeParse(kind)
    return readable.success
      ? { ...rest, kind: readable.data }
      : { ...rest, kind: 'unsupported' as const, type: kind }
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
    const inserted = this.db
      .prepare(`INSERT INTO reply_files(account,mid,name,bytes)
      SELECT account,mid,?,? FROM inbox WHERE account=? AND mid=? AND reply_done=0 AND review=0`)
      .run(name, bytes, account, mid)
    if (!inserted.changes) {
      throw new Error('This Feishu delivery cannot receive another file')
    }
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
  /** Reserves the streamed reply once, so a lost receipt can't post a second one. */
  takeCard(account: string, mid: string): boolean {
    return Boolean(
      this.db
        .prepare('UPDATE inbox SET progress=2 WHERE account=? AND mid=? AND progress=0')
        .run(account, mid).changes
    )
  }
  setCard(account: string, mid: string, card: string): void {
    this.db
      .prepare('UPDATE inbox SET card=? WHERE account=? AND mid=? AND card IS NULL')
      .run(card, account, mid)
  }
  abandonCard(account: string, mid: string): void {
    this.db.prepare("UPDATE inbox SET card='' WHERE account=? AND mid=?").run(account, mid)
  }
  /** The streamed reply shows its final words; a retry only owes what follows it. */
  cardFinal(account: string, mid: string): void {
    this.db
      .prepare("UPDATE inbox SET progress=3 WHERE account=? AND mid=? AND card<>''")
      .run(account, mid)
  }
  card(account: string, mid: string) {
    const row = this.db
      .prepare('SELECT card,progress,excerpt FROM inbox WHERE account=? AND mid=?')
      .get(account, mid)
    return row
      ? z
          .object({
            card: z.string().nullable(),
            progress: z.number(),
            excerpt: z.string().nullable()
          })
          .parse(row)
      : null
  }
  merged(account: string, mids: string[], head: string): void {
    const mark = this.db.prepare(
      'UPDATE inbox SET answered_by=? WHERE account=? AND mid=? AND mid<>? AND answered_by IS NULL'
    )
    for (const mid of mids) {
      mark.run(head, account, mid, head)
    }
  }
  /** The owner's words a reply answers besides the head's, oldest first. */
  mergedExcerpts(account: string, head: string): string[] {
    return this.db
      .prepare('SELECT excerpt FROM inbox WHERE account=? AND answered_by=? ORDER BY rowid')
      .all(account, head)
      .map((row) => String(row.excerpt ?? ''))
      .filter(Boolean)
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
  /** Messages for the owner to look at; the retryable ones never reached a chat. */
  reviewCount(account: string): { count: number; retryable: number } {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS count, COALESCE(SUM(body IS NOT NULL AND reply_done=0),0) AS retryable FROM inbox WHERE account=? AND review=1'
      )
      .get(account)
    return { count: Number(row?.count ?? 0), retryable: Number(row?.retryable ?? 0) }
  }
  /** Messages no chat took go to one again, under their own delivery ids. */
  retryReview(account: string): number {
    return Number(
      this.db
        .prepare(
          'UPDATE inbox SET review=0 WHERE account=? AND review=1 AND body IS NOT NULL AND reply_done=0'
        )
        .run(account).changes
    )
  }
  /** Seen by the owner: never delivered nor shown again. */
  dismissReview(account: string): number {
    return Number(
      this.db
        .prepare(
          'UPDATE inbox SET review=2,body=NULL,stored_path=NULL WHERE account=? AND review=1'
        )
        .run(account).changes
    )
  }
  replyState(account: string, mid: string) {
    const row = this.db
      .prepare('SELECT first_post,review,reply_done FROM inbox WHERE account=? AND mid=?')
      .get(account, mid)
    return (
      row && {
        firstPost: typeof row.first_post === 'number' ? row.first_post : null,
        review: !!row.review,
        done: !!row.reply_done
      }
    )
  }
  /** Keep the local outcome even if the independent native journal cannot settle yet. */
  finishReply(account: string, mid: string, review: boolean): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const changed = review && this.review(account, mid)
      this.db.prepare('UPDATE inbox SET reply_done=1 WHERE account=? AND mid=?').run(account, mid)
      this.db
        .prepare('DELETE FROM reply_files WHERE account=? AND mid=? AND bytes IS NOT NULL')
        .run(account, mid)
      this.db.exec('COMMIT')
      return changed
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  /** A reply whose outcome was lost must only be retried within Feishu's one-hour UUID window. */
  postWindowStart(account: string, mid: string, now: number): number | null {
    this.db
      .prepare(
        'UPDATE inbox SET first_post=? WHERE account=? AND mid=? AND first_post IS NULL AND review=0 AND reply_done=0'
      )
      .run(now, account, mid)
    const row = this.replyState(account, mid)
    return row && !row.review && !row.done ? row.firstPost : null
  }
}
