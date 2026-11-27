import { migrateFeishuInbox } from './feishu-inbox-migrations'
import { FeishuReplyCheckpoints } from './feishu-reply-checkpoints'
import { FeishuReplyFiles } from './feishu-reply-files'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import Database from '../sqlite/sync-database'
import type { FeishuMessage, FeishuProfile } from './feishu-cli'
import { FeishuResponseStore } from './feishu-response-store'
import { FeishuCardStore } from './feishu-card-store'
import { FeishuRoutes } from './feishu-routes'
import { binding, type Binding } from './feishu-binding'
import { claimFeishuControl } from './feishu-control-access'
import type { BotMember } from '../../shared/bot-types'
import { FeishuAdmissions } from './feishu-admissions'
import { FeishuDeliveryFailures } from './feishu-delivery-failures'

const inReplyWindow = (first: number, now: number): boolean =>
  now >= first && now - first < 55 * 60_000

/** One database per installation. A CLI app can belong to just one Orca profile and bot. */
export class FeishuInbox {
  private checkpoints: FeishuReplyCheckpoints
  private db: Database.Database
  private cards: FeishuCardStore
  private responses: FeishuResponseStore
  private admissions: FeishuAdmissions
  private routes: FeishuRoutes
  private files: FeishuReplyFiles
  private failures: FeishuDeliveryFailures
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
    migrateFeishuInbox(this.db)
    this.checkpoints = new FeishuReplyCheckpoints(this.db)
    this.files = new FeishuReplyFiles(this.db)
    this.failures = new FeishuDeliveryFailures(this.db)
    this.cards = new FeishuCardStore(this.db)
    this.responses = new FeishuResponseStore(this.db, this.cards)
    this.routes = new FeishuRoutes(this.db)
    this.admissions = new FeishuAdmissions(this.db, this.routes)
  }
  deliveryReady = (...args: Parameters<FeishuDeliveryFailures['ready']>) =>
    this.failures.ready(...args)
  deliveryFailed = (...args: Parameters<FeishuDeliveryFailures['failed']>) =>
    this.failures.failed(...args)
  deliverySucceeded = (...args: Parameters<FeishuDeliveryFailures['succeeded']>) =>
    this.failures.succeeded(...args)
  deliveryRetrying = (account: string) => this.failures.retrying(account)
  putRoute = (...args: Parameters<FeishuRoutes['put']>) => this.routes.put(...args)
  messageRoute(account: string, mid: string) {
    return this.routes.message(account, mid)
  }
  laneRoute(account: string, external: string) {
    return this.routes.lane(account, external)
  }
  cardkit = (...args: Parameters<FeishuCardStore['cardkit']>) => this.cards.cardkit(...args)
  cardSequence = (...args: Parameters<FeishuCardStore['sequence']>) => this.cards.sequence(...args)
  getCard = (...args: Parameters<FeishuCardStore['get']>) => this.cards.get(...args)
  replyMessage = (...args: Parameters<FeishuCardStore['replyMessage']>) =>
    this.cards.replyMessage(...args)
  questionResponse = (...args: Parameters<FeishuCardStore['questionResponse']>) =>
    this.cards.questionResponse(...args)
  questionContinuation = (...args: Parameters<FeishuCardStore['questionContinuation']>) =>
    this.cards.questionContinuation(...args)
  updateResponse = (...args: Parameters<FeishuResponseStore['update']>) =>
    this.responses.update(...args)
  workerResponse = (...args: Parameters<FeishuResponseStore['workerResponse']>) =>
    this.responses.workerResponse(...args)
  putCard = (...args: Parameters<FeishuCardStore['put']>) => this.cards.put(...args)
  pendingChoice = (...args: Parameters<FeishuCardStore['pendingChoice']>) =>
    this.cards.pendingChoice(...args)
  pendingCards = (...args: Parameters<FeishuCardStore['pending']>) => this.cards.pending(...args)
  claimCardFor(
    b: Binding,
    members: readonly BotMember[],
    actor: string,
    message: string,
    chat: string,
    option: string,
    question?: string
  ) {
    return claimFeishuControl(
      this.cards,
      this.admissions,
      b,
      members,
      actor,
      message,
      chat,
      option,
      question
    )
  }
  claimCard = (...args: Parameters<FeishuCardStore['claim']>) => this.cards.claim(...args)
  closeCard = (...args: Parameters<FeishuCardStore['close']>) => this.cards.close(...args)
  closePrompts = (...args: Parameters<FeishuCardStore['closePrompts']>) =>
    this.cards.closePrompts(...args)
  sendingCard(account: string, id: string, now: number) {
    return this.cards.sending(account, id, now)
  }
  postedCard(account: string, id: string, revision: number, message: string | null) {
    this.cards.posted(account, id, revision, message)
  }
  close(): void {
    this.db.close()
  }
  bindings(scope: string): Binding[] {
    return this.db
      .prepare(
        'SELECT account,bot,CASE WHEN sealed_secret IS NULL THEN profile END AS profile,app,owner,chat,pairedAt FROM bindings WHERE scope=?'
      )
      .all(scope)
      .map((row) => binding.parse(row))
  }
  add(
    scope: string,
    bot: string,
    setup: FeishuProfile | { appId: string; sealedSecret: string }
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
      pairedAt: null
    }
    this.db
      .prepare(
        'INSERT INTO bindings(account,scope,bot,profile,app,sealed_secret) VALUES(?,?,?,?,?,?)'
      )
      .run(b.account, scope, bot, b.profile ?? b.app, b.app, sealed)
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
  accept = (...args: Parameters<FeishuAdmissions['accept']>) => this.admissions.accept(...args)
  next = (account: string) => this.admissions.next(account)
  sender = (account: string, mid: string) => this.admissions.sender(account, mid)
  laneSender = (account: string, external: string) => this.admissions.laneSender(account, external)
  stored(account: string, mid: string, path: string): void {
    this.db
      .prepare('UPDATE inbox SET stored_path=? WHERE account=? AND mid=? AND body IS NOT NULL')
      .run(path, account, mid)
  }
  stageFile = (...args: Parameters<FeishuReplyFiles['stageFile']>) => this.files.stageFile(...args)
  artifacts = (...args: Parameters<FeishuReplyFiles['artifacts']>) => this.files.artifacts(...args)
  uploaded = (...args: Parameters<FeishuReplyFiles['uploaded']>) => this.files.uploaded(...args)
  filePosted = (...args: Parameters<FeishuReplyFiles['filePosted']>) =>
    this.files.filePosted(...args)
  takeProgress(account: string, mid: string): boolean {
    return Boolean(
      this.db
        .prepare('UPDATE inbox SET progress=1 WHERE account=? AND mid=? AND progress=0')
        .run(account, mid).changes
    )
  }
  admitted(account: string, mid: string): void {
    this.db
      .prepare('UPDATE inbox SET body=NULL,stored_path=NULL,context=NULL WHERE account=? AND mid=?')
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
  pendingReplies(account: string, after: string | null = null) {
    return this.db
      .prepare(
        'SELECT id,mid,text FROM text_replies WHERE account=? AND message_id IS NULL AND review=0 AND rowid>COALESCE((SELECT rowid FROM text_replies WHERE account=? AND id=?),0) ORDER BY rowid LIMIT 32'
      )
      .all(account, account, after)
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
  review(account: string, mid: string): boolean {
    return !!this.db
      .prepare('UPDATE inbox SET review=1 WHERE account=? AND mid=? AND review=0')
      .run(account, mid).changes
  }
  needsReview(account: string): boolean {
    return (
      this.failures.needsReview(account) ||
      Boolean(
        this.db
          .prepare('SELECT 1 FROM feishu_cards WHERE account=? AND review=1 LIMIT 1')
          .get(account) ||
        this.db.prepare('SELECT 1 FROM inbox WHERE account=? AND review=1 LIMIT 1').get(account) ||
        this.db
          .prepare('SELECT 1 FROM text_replies WHERE account=? AND review=1 LIMIT 1')
          .get(account)
      )
    )
  }
  replyState = (...args: Parameters<FeishuReplyCheckpoints['replyState']>) =>
    this.checkpoints.replyState(...args)
  finishReply = (...args: Parameters<FeishuReplyCheckpoints['finishReply']>) =>
    this.checkpoints.finishReply(...args)
  postWindowStart = (...args: Parameters<FeishuReplyCheckpoints['postWindowStart']>) =>
    this.checkpoints.postWindowStart(...args)
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
