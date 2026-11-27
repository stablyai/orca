import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type Database from '../sqlite/sync-database'

import { cardData, type FeishuCardData } from './feishu-card-data'
import { responseCardId, responseDestination } from './feishu-card-links'
import { syncInlineQuestion } from './feishu-inline-question-state'
const row = lazyZodSchema(() =>
  z.object({
    id: z.string(),
    external: z.string(),
    original: z.string(),
    chat: z.string(),
    message: z.string().nullable(),
    body: z.string(),
    revision: z.number(),
    sent: z.number(),
    state: z.enum(['open', 'claimed', 'closed']),
    selected: z.string().nullable(),
    first_post: z.number().nullable(),
    review: z.number(),
    cardkit: z.string().nullable(),
    cardkit_sequence: z.number()
  })
)
export type FeishuCardRow = z.infer<typeof row>

export class FeishuCardStore {
  constructor(private readonly db: Database.Database) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS feishu_response_links(account TEXT NOT NULL REFERENCES bindings(account) ON DELETE CASCADE, delivery TEXT NOT NULL, card TEXT NOT NULL, PRIMARY KEY(account,delivery))'
    )
    db.exec(`CREATE TABLE IF NOT EXISTS feishu_cards(account TEXT NOT NULL REFERENCES bindings(account) ON DELETE CASCADE,
      id TEXT NOT NULL,external TEXT NOT NULL,original TEXT NOT NULL,chat TEXT NOT NULL,message TEXT,
      body TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,sent INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'open',selected TEXT,first_post INTEGER,review INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(account,id),UNIQUE(account,message));`)
    const columns = db.prepare('PRAGMA table_info(feishu_cards)').all()
    if (!columns.some((c) => c.name === 'cardkit')) {
      db.exec(
        'ALTER TABLE feishu_cards ADD COLUMN cardkit TEXT; ALTER TABLE feishu_cards ADD COLUMN cardkit_sequence INTEGER NOT NULL DEFAULT 0'
      )
    }
  }
  cardkit(account: string, id: string, entity: string) {
    this.db
      .prepare('UPDATE feishu_cards SET cardkit=? WHERE account=? AND id=? AND cardkit IS NULL')
      .run(entity, account, id)
  }
  sequence(account: string, id: string) {
    this.db
      .prepare(
        'UPDATE feishu_cards SET cardkit_sequence=cardkit_sequence+1 WHERE account=? AND id=?'
      )
      .run(account, id)
    const card = this.get(account, id)
    if (!card?.cardkit) {
      throw new Error('CardKit entity missing')
    }
    return card.cardkit_sequence
  }
  put(
    account: string,
    id: string,
    external: string,
    original: string,
    chat: string,
    data: FeishuCardData
  ) {
    const body = JSON.stringify(cardData.parse(data))
    const existing = this.get(account, id)
    if (existing) {
      if (
        existing.external !== external ||
        existing.original !== original ||
        existing.chat !== chat
      ) {
        throw new Error('Card identity changed')
      }
      if (data.kind !== 'status' && data.kind !== 'response') {
        syncInlineQuestion(this.db, this, account, existing)
        return
      }
      this.db
        .prepare(
          'UPDATE feishu_cards SET body=?,revision=revision+1 WHERE account=? AND id=? AND body<>?'
        )
        .run(body, account, id, body)
    } else {
      this.db
        .prepare(
          'INSERT INTO feishu_cards(account,id,external,original,chat,body) VALUES(?,?,?,?,?,?)'
        )
        .run(account, id, external, original, chat, body)
    }
    if (data.kind === 'async-question' || data.inline) {
      syncInlineQuestion(this.db, this, account, this.get(account, id)!)
    }
  }
  questionResponse(account: string, id: string) {
    const q = this.get(account, id)
    return (
      q &&
      responseDestination(
        this,
        account,
        responseCardId(this.db, account, q.original),
        q.external,
        q.chat
      )
    )
  }
  replyMessage(account: string, mid: string) {
    return this.get(account, responseCardId(this.db, account, mid))?.message ?? mid
  }
  questionContinuation(account: string, id: string) {
    const q = this.get(account, id),
      parent = this.questionResponse(account, id)
    if (
      !q ||
      q.state !== 'claimed' ||
      !parent?.message ||
      cardData.parse(JSON.parse(parent.body)).response?.question?.id !== id
    ) {
      return null
    }
    const mid = `om_orca_choice_${createHash('sha256').update(id).digest('hex')}`
    this.db
      .prepare('INSERT OR IGNORE INTO feishu_response_links(account,delivery,card) VALUES(?,?,?)')
      .run(account, mid, parent.id)
    return { mid, message: parent.message }
  }
  byMessage(account: string, message: string, chat: string) {
    const found = this.db
      .prepare('SELECT * FROM feishu_cards WHERE account=? AND message=? AND chat=?')
      .get(account, message, chat)
    return found ? row.parse(found) : null
  }
  get(account: string, id: string) {
    const found = this.db
      .prepare('SELECT * FROM feishu_cards WHERE account=? AND id=?')
      .get(account, id)
    return found ? row.parse(found) : null
  }
  pendingChoice(account: string, original: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM feishu_cards WHERE account=? AND original=? AND id LIKE 'choices:%' AND message IS NULL AND revision>sent AND review=0 LIMIT 1"
        )
        .get(account, original)
    )
  }
  pending(account: string, after: string | null = null) {
    return this.db
      .prepare(
        "SELECT * FROM feishu_cards WHERE account=? AND review=0 AND (revision>sent OR state='claimed') AND rowid>COALESCE((SELECT rowid FROM feishu_cards WHERE account=? AND id=?),0) ORDER BY rowid LIMIT 32"
      )
      .all(account, account, after)
      .map((r) => row.parse(r))
  }
  claim(account: string, message: string, chat: string, option: string, questionId?: string) {
    const found = this.db
      .prepare('SELECT * FROM feishu_cards WHERE account=? AND message=? AND chat=?')
      .get(account, message, chat)
    if (!found) {
      return null
    }
    let card = row.parse(found),
      data = cardData.parse(JSON.parse(card.body))
    if (data.kind === 'response') {
      if (
        !questionId ||
        data.response?.supersededBy ||
        data.response?.question?.id !== questionId ||
        !data.response.question.inline
      ) {
        return null
      }
      const control = this.get(account, questionId)
      if (!control || control.external !== card.external || control.chat !== chat) {
        return null
      }
      card = control
      data = cardData.parse(JSON.parse(card.body))
    }
    if (
      card.state !== 'open' ||
      card.review ||
      data.kind === 'status' ||
      data.kind === 'response' ||
      !data.options.some((o) => o.id === option)
    ) {
      return null
    }
    const changed = this.db
      .prepare(
        "UPDATE feishu_cards SET state='claimed',selected=?,body=?,revision=revision+1 WHERE account=? AND id=? AND state='open'"
      )
      .run(
        option,
        JSON.stringify({
          ...data,
          note: `已选择：${data.options.find((o) => o.id === option)!.label}`
        }),
        account,
        card.id
      ).changes
    const claimed = changed ? this.get(account, card.id) : null
    if (claimed) {
      syncInlineQuestion(this.db, this, account, claimed)
    }
    return claimed
  }
  close(account: string, id: string, note: string) {
    const card = this.get(account, id)
    if (!card || card.state === 'closed') {
      return
    }
    const data = cardData.parse(JSON.parse(card.body))
    this.db
      .prepare(
        "UPDATE feishu_cards SET body=?,state='closed',revision=revision+1 WHERE account=? AND id=?"
      )
      .run(JSON.stringify({ ...data, note }), account, id)
    syncInlineQuestion(this.db, this, account, this.get(account, id)!)
  }
  closePrompts(
    account: string,
    external: string,
    keep: string | null,
    note: string,
    kind: 'prompt' | 'async-question' | 'resume' = 'prompt'
  ) {
    for (const raw of this.db
      .prepare("SELECT * FROM feishu_cards WHERE account=? AND external=? AND state='open'")
      .all(account, external)) {
      const card = row.parse(raw),
        data = cardData.parse(JSON.parse(card.body))
      if (data.kind === kind && data.promptId !== keep) {
        this.close(account, card.id, note)
      }
    }
  }
  sending(account: string, id: string, now: number) {
    this.db
      .prepare(
        'UPDATE feishu_cards SET first_post=? WHERE account=? AND id=? AND first_post IS NULL'
      )
      .run(now, account, id)
    const card = this.get(account, id)
    if (!card || card.review) {
      return false
    }
    if (
      !card.message &&
      (card.first_post === null || now - card.first_post >= 55 * 60_000 || now < card.first_post)
    ) {
      this.db.prepare('UPDATE feishu_cards SET review=1 WHERE account=? AND id=?').run(account, id)
      return false
    }
    return true
  }
  posted(account: string, id: string, revision: number, message: string | null) {
    this.db
      .prepare('UPDATE feishu_cards SET message=?,sent=MAX(sent,?) WHERE account=? AND id=?')
      .run(message, revision, account, id)
  }
}
