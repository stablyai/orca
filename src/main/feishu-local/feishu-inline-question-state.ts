import type Database from '../sqlite/sync-database'
import type { FeishuCardStore, FeishuCardRow } from './feishu-card-store'
import { cardData } from './feishu-card-data'
import { responseCardId, responseDestination } from './feishu-card-links'

export function syncInlineQuestion(
  db: Database.Database,
  cards: FeishuCardStore,
  account: string,
  question: FeishuCardRow
) {
  const detail = cardData.parse(JSON.parse(question.body))
  if (detail.kind !== 'async-question' && !detail.inline) {
    return
  }
  const card = responseDestination(
    cards,
    account,
    responseCardId(db, account, question.original),
    question.external,
    question.chat
  )
  if (!card) {
    return
  }
  const data = cardData.parse(JSON.parse(card.body))
  if (!data.response) {
    return
  }
  const current = data.response.question
  if (current && current.id !== question.id) {
    const newer = db
      .prepare(
        'SELECT 1 FROM feishu_cards WHERE account=? AND id=? AND rowid>(SELECT rowid FROM feishu_cards WHERE account=? AND id=?)'
      )
      .get(account, question.id, account, current.id)
    if (!newer) {
      return
    }
  }
  data.response.question = {
    id: question.id,
    pending: question.state === 'open',
    ...(detail.kind === 'resume' ? { resume: true } : {}),
    ...(detail.inline
      ? { inline: true, text: detail.text, options: detail.options, note: detail.note }
      : {})
  }
  cards.put(account, card.id, card.external, card.original, card.chat, data)
}
