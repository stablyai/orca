import type Database from '../sqlite/sync-database'
import type { FeishuCardStore } from './feishu-card-store'
import { cardData } from './feishu-card-data'

export function responseCardId(db: Database.Database, account: string, original: string) {
  const alias = db
    .prepare('SELECT card FROM feishu_response_links WHERE account=? AND delivery=?')
    .get(account, original)
  return alias ? String(alias.card) : `response:${original}`
}

export function responseDestination(
  cards: Pick<FeishuCardStore, 'get'>,
  account: string,
  id: string,
  external: string,
  chat: string
) {
  const seen = new Set<string>()
  while (!seen.has(id)) {
    seen.add(id)
    const card = cards.get(account, id)
    if (!card || card.external !== external || card.chat !== chat) {
      return null
    }
    const next = cardData.parse(JSON.parse(card.body)).response?.supersededBy
    if (!next) {
      return card
    }
    id = next
  }
  return null
}
