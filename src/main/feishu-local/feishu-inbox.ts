import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import Database from '../sqlite/sync-database'
import type { FeishuProfile } from './feishu-cli'
import { FeishuGroupPolicy } from '../../shared/bots/feishu-local'
import { FeishuGroupRoute, type FeishuInboundMessage, type FeishuMessage } from './feishu-message'
import { binding, groupKey, type Binding } from './feishu-binding'
import { initializeFeishuInbox } from './feishu-inbox-schema'
/** One database per installation. A CLI app can belong to just one Orca profile and bot. */
export class FeishuInbox {
  private db: Database.Database
  constructor(path: string) {
    this.db = new Database(path)
    initializeFeishuInbox(this.db)
  }
  close(): void {
    this.db.close()
  }
  bindings(scope: string): Binding[] {
    return this.db
      .prepare(
        'SELECT account,bot,CASE WHEN sealed_secret IS NULL THEN profile END AS profile,app,owner,chat,pairedAt,group_policy FROM bindings WHERE scope=?'
      )
      .all(scope)
      .map((row) =>
        binding.parse({
          ...row,
          ...(typeof row.group_policy === 'string'
            ? { group: FeishuGroupPolicy.parse(JSON.parse(row.group_policy)) }
            : {})
        })
      )
  }
  add(
    scope: string,
    bot: string,
    setup: FeishuProfile | { appId: string; sealedSecret: string; group?: FeishuGroupPolicy }
  ): Binding {
    const sealed = 'sealedSecret' in setup ? setup.sealedSecret : null
    if (sealed === '') {
      throw new Error('Missing sealed Feishu credential')
    }
    const b = {
      account: `local-feishu/${randomUUID()}`,
      bot,
      profile: 'name' in setup ? setup.name : null,
      app: setup.appId,
      owner: null,
      chat: null,
      pairedAt: null,
      ...('group' in setup && setup.group ? { group: setup.group } : {})
    }
    this.db
      .prepare(
        'INSERT INTO bindings(account,scope,bot,profile,app,sealed_secret,group_policy) VALUES(?,?,?,?,?,?,?)'
      )
      .run(
        b.account,
        scope,
        bot,
        b.profile ?? b.app,
        b.app,
        sealed,
        b.group ? JSON.stringify(b.group) : null
      )
    return b
  }
  credential(account: string): string | null {
    const value = this.db
      .prepare('SELECT sealed_secret FROM bindings WHERE account=?')
      .get(account)?.sealed_secret
    return typeof value === 'string' ? value : null
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
  accept(b: Binding, m: FeishuInboundMessage): boolean {
    if (!b.owner || b.pairedAt === null || Number(m.create_time) <= b.pairedAt) {
      return false
    }
    const group = m.chat_type === 'p2p' ? undefined : m.group
    if (m.chat_type === 'p2p') {
      if (m.sender_id !== b.owner || m.chat_id !== b.chat) {
        return false
      }
    } else if (
      b.profile !== null ||
      b.group?.chatId !== m.chat_id ||
      !b.group.members.includes(m.sender_id) ||
      m.group.chatId !== m.chat_id ||
      m.group.sender !== m.sender_id ||
      m.message_type !== 'text'
    ) {
      return false
    }
    // Older DM-only builds treat every non-null body as private mail.
    const accepted = this.db
      .prepare(
        'INSERT OR IGNORE INTO inbox(account,mid,event,body,kind,group_route,group_key,group_body) VALUES(?,?,?,?,?,?,?,?)'
      )
      .run(
        b.account,
        m.message_id,
        m.event_id,
        group ? null : m.content,
        m.message_type,
        group ? JSON.stringify(group) : null,
        group ? groupKey(b, group).externalId : null,
        group ? m.content : null
      )
    return accepted.changes !== 0
  }
  next(account: string) {
    // The native outbox attaches a turn's answer to its first delivery.
    const row = this.db
      .prepare(
        `SELECT mid,COALESCE(body,group_body) AS body,kind,stored_path AS path,group_route AS route
          FROM inbox AS pending
          WHERE account=? AND (body IS NOT NULL OR group_body IS NOT NULL) AND review=0
            AND (group_key IS NULL OR NOT EXISTS (
              SELECT 1 FROM inbox AS prior WHERE prior.account=pending.account
                AND prior.group_key IS NOT NULL AND prior.group_key=pending.group_key
                AND prior.reply_done=0 AND prior.rowid<pending.rowid
            ))
          ORDER BY rowid LIMIT 1`
      )
      .get(account)
    return (
      row &&
      z
        .object({
          mid: z.string(),
          body: z.string(),
          kind: z.enum(['text', 'image', 'file', 'post']),
          path: z.string().nullable(),
          route: z.string().nullable()
        })
        .transform(({ route, ...value }) => ({
          ...value,
          ...(route ? { group: FeishuGroupRoute.parse(JSON.parse(route)) } : {})
        }))
        .parse(row)
    )
  }
  groupRoute(account: string, mid: string): FeishuGroupRoute | undefined {
    const route = this.db
      .prepare('SELECT group_route FROM inbox WHERE account=? AND mid=?')
      .get(account, mid)?.group_route
    return typeof route === 'string' ? FeishuGroupRoute.parse(JSON.parse(route)) : undefined
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
      SELECT account,mid,?,? FROM inbox WHERE account=? AND mid=? AND group_route IS NULL AND reply_done=0 AND review=0`)
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
  takeProgress(account: string, mid: string): boolean {
    return Boolean(
      this.db
        .prepare('UPDATE inbox SET progress=1 WHERE account=? AND mid=? AND progress=0')
        .run(account, mid).changes
    )
  }
  admitted(account: string, mid: string): void {
    this.db
      .prepare(
        'UPDATE inbox SET body=NULL,group_body=NULL,stored_path=NULL WHERE account=? AND mid=?'
      )
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
