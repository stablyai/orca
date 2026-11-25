import { z } from 'zod'
import type Database from '../sqlite/sync-database'

import { cardData, type FeishuCardData } from './feishu-card-data'
const row = z.object({
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
  review: z.number()
})
export type FeishuCardRow = z.infer<typeof row>

export class FeishuCardStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS feishu_cards(account TEXT NOT NULL REFERENCES bindings(account) ON DELETE CASCADE,
      id TEXT NOT NULL,external TEXT NOT NULL,original TEXT NOT NULL,chat TEXT NOT NULL,message TEXT,
      body TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,sent INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'open',selected TEXT,first_post INTEGER,review INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(account,id),UNIQUE(account,message));`)
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
      if (data.kind !== 'status') {
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
          "SELECT 1 FROM feishu_cards WHERE account=? AND original=? AND id LIKE 'choices:%' AND message IS NULL AND review=0 LIMIT 1"
        )
        .get(account, original)
    )
  }
  pending(account: string) {
    return this.db
      .prepare(
        "SELECT * FROM feishu_cards WHERE account=? AND review=0 AND (revision>sent OR state='claimed') ORDER BY rowid LIMIT 32"
      )
      .all(account)
      .map((r) => row.parse(r))
  }
  claim(account: string, message: string, chat: string, option: string) {
    const found = this.db
      .prepare('SELECT * FROM feishu_cards WHERE account=? AND message=? AND chat=?')
      .get(account, message, chat)
    if (!found) {
      return null
    }
    const card = row.parse(found),
      data = cardData.parse(JSON.parse(card.body))
    if (
      card.state !== 'open' ||
      card.review ||
      data.kind === 'status' ||
      !data.options.some((o) => o.id === option)
    ) {
      return null
    }
    const changed = this.db
      .prepare(
        "UPDATE feishu_cards SET state='claimed',selected=? WHERE account=? AND id=? AND state='open'"
      )
      .run(option, account, card.id).changes
    return changed ? this.get(account, card.id) : null
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
  }
  closePrompts(account: string, external: string, keep: string | null, note: string) {
    for (const raw of this.db
      .prepare("SELECT * FROM feishu_cards WHERE account=? AND external=? AND state='open'")
      .all(account, external)) {
      const card = row.parse(raw),
        data = cardData.parse(JSON.parse(card.body))
      if (data.kind === 'prompt' && data.promptId !== keep) {
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
  posted(account: string, id: string, revision: number, message: string) {
    this.db
      .prepare('UPDATE feishu_cards SET message=?,sent=MAX(sent,?) WHERE account=? AND id=?')
      .run(message, revision, account, id)
  }
}
