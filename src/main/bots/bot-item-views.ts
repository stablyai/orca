// Bot items as the wire shows them: a store's view rows joined with their links' workers and owners.
import type { Bot } from '../../shared/bot-types'
import { botItemEventId, type BotItem } from '../../shared/bots/bot-items'
import { botItemQuestionView } from '../../shared/bots/bot-item-ask'
import type { BotItemLinkJoin } from './bot-items-link-join'
import type { BotItemsRemote } from './bot-items-ops'
import type { BotItemRecord } from './bot-items-schema'

export type BotItemViewDeps = {
  join: BotItemLinkJoin
  bots: () => readonly Bot[]
  owningChat: (item: Pick<BotItemRecord, 'chatId' | 'source'>) => BotItem['chat']
}

export async function botItemViewsFromRows(
  deps: BotItemViewDeps,
  items: readonly BotItemRecord[],
  rows: Awaited<ReturnType<BotItemsRemote['viewRows']>>,
  summary: boolean
): Promise<BotItem[]> {
  const refs = Object.values(rows.links)
    .flat()
    .flatMap((link) => (link.kind === 'dispatch' ? [link.ref] : []))
  const workers = await deps.join.readLinkedWorkers(refs)
  const byUid = new Map(rows.items.map((item) => [item.uid, item]))
  const bots = deps.bots()
  const nameOf = (botId: string) => bots.find((bot) => bot.id === botId)?.name ?? null
  return items.map((given): BotItem => {
    const item = byUid.get(given.uid) ?? given
    const question = rows.questions[item.uid]
    const wait = rows.waits[item.uid]
    const waitText = typeof wait?.data.note === 'string' ? wait.data.note : null
    const { madeBy } = item
    return {
      uid: item.uid,
      number: item.number,
      owner: { botId: item.ownerBotId, name: nameOf(item.ownerBotId) },
      title: item.title,
      description: summary ? null : item.description,
      doneMeans: summary ? null : item.doneMeans,
      status: item.status,
      chat: deps.owningChat(item),
      madeBy: madeBy
        ? { botId: madeBy.botId, name: nameOf(madeBy.botId), chatId: madeBy.chatId }
        : null,
      question: question ? botItemQuestionView(botItemEventId(question.id), question.data) : null,
      ...(rows.waitingAsks[item.uid] ? { waitingAsk: rows.waitingAsks[item.uid] } : {}),
      closeNote: summary ? null : item.closeNote,
      wait: wait && waitText !== null ? { text: waitText, at: wait.createdAt } : null,
      links: (rows.links[item.uid] ?? []).map((link) =>
        deps.join.linkView(link, workers.get(link.ref))
      ),
      version: item.version,
      lastEventId: botItemEventId(item.lastEventId),
      othersLastEventId: botItemEventId(rows.othersLast[item.uid] ?? 0),
      snoozedUntil: item.snoozedUntil,
      lastActivityAt: item.lastActivityAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      closedAt: item.closedAt
    }
  })
}
