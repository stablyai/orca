// Orca's asks as the phone lists them in Needs you: the chats waiting on the owner and their workers,
// read from the chats tree it already has. Sign-ins and access requests stay on the desktop for now,
// so the phone's count can be lower than the desktop's.
import { useMemo } from 'react'
import type { BotChatTreeChat, BotChatTreeWorker } from '../../../../src/shared/bots/bot-chat-tree'
import {
  botItemsByDispatch,
  filterBotNeeds,
  type BotItemFilter
} from '../../../../src/shared/bots/bot-item-groups'
import type { BotItem } from '../../../../src/shared/bots/bot-items'
import { botNeedsYouCount } from '../../../../src/shared/bots/bot-now'

export type PhoneAsk = {
  key: string
  approval: boolean
  title: string
  /** The worker that asks, when the row takes its item's title. */
  worker: string | null
  /** That item's number. */
  number: number | null
  /** The tool an approval asks to run, when the worker's status says. */
  tool: { name: string; input: string | null } | null
  /** The chat it belongs to, for the chat filter. */
  chatId: string
  /** What a tap opens; null when the phone can't reach it. */
  open: { chat: BotChatTreeChat } | { worker: BotChatTreeWorker } | null
}

/** What the activity read says of a worker: its dot and the tool its permission prompt asks for. */
export type PhoneWorkerAsk = { dot: string; tool?: { name: string; input: string | null } }

/** Approvals first, then the rest, each in the tree's order (needs-you first, then newest). */
export function phoneNeedsYouAsks(
  chats: readonly BotChatTreeChat[],
  workerAsk: (dispatchId: string) => PhoneWorkerAsk | null,
  itemOf: (dispatchId: string) => Pick<BotItem, 'title' | 'number'> | null
): PhoneAsk[] {
  const asks: PhoneAsk[] = []
  for (const chat of chats) {
    if (chat.closed) {
      continue
    }
    if (chat.live === 'needs-you') {
      asks.push({
        key: `chat:${chat.chatId}`,
        approval: false,
        title: chat.title,
        worker: null,
        number: null,
        tool: null,
        chatId: chat.chatId,
        open: { chat }
      })
    }
    for (const worker of chat.running) {
      if (worker.state !== 'needs-you') {
        continue
      }
      const seen = worker.dispatchId ? workerAsk(worker.dispatchId) : null
      const item = worker.dispatchId ? itemOf(worker.dispatchId) : null
      asks.push({
        key: `worker:${worker.key}`,
        approval: seen?.dot === 'permission',
        title: item?.title ?? worker.title,
        worker: item ? worker.title : null,
        number: item?.number ?? null,
        tool: seen?.tool ?? null,
        chatId: chat.chatId,
        // A handed agent with no Dispatch opens only where the tree placed it.
        open: worker.dispatchId || worker.worktreeId ? { worker } : null
      })
    }
  }
  return [...asks.filter((ask) => ask.approval), ...asks.filter((ask) => !ask.approval)]
}

/** The phone's existing openers: a chat from the tree, a worker where the tree or its host finds it. */
export type PhoneAskOpeners = {
  chat: (chat: BotChatTreeChat) => void
  worker: (worker: BotChatTreeWorker) => void
}

export function openPhoneAsk(ask: PhoneAsk, openers: PhoneAskOpeners): void {
  if (ask.open) {
    if ('chat' in ask.open) {
      openers.chat(ask.open.chat)
    } else {
      openers.worker(ask.open.worker)
    }
  }
}

/** The asks the filter keeps (`shown`), and the tab's count: every ask the phone reads plus `itemCount`.
 *  It is what the phone lists, so it is lower than the desktop's when a sign-in or access request waits. */
export function usePhoneNeedsYouAsks({
  chats,
  workers,
  items,
  filter,
  itemCount
}: {
  /** The chats tree once read. */
  chats: readonly BotChatTreeChat[] | null
  /** The activity read's workers, for their dots and tools. */
  workers: readonly ({ key: string } & PhoneWorkerAsk)[] | undefined
  items: readonly BotItem[] | undefined
  filter: BotItemFilter
  /** Needs you items that aren't stale, unfiltered. */
  itemCount: number
}): { shown: readonly PhoneAsk[]; count: number } {
  const all = useMemo(() => {
    const byDispatch = botItemsByDispatch(items ?? [])
    const seen = new Map((workers ?? []).map((row) => [row.key, row]))
    return phoneNeedsYouAsks(
      chats ?? [],
      (dispatchId) => seen.get(`worker:${dispatchId}`) ?? null,
      (dispatchId) => byDispatch.get(dispatchId) ?? null
    )
  }, [chats, workers, items])
  const shown = useMemo(() => filterBotNeeds(all, filter, (ask) => ask.chatId), [all, filter])
  return { shown, count: botNeedsYouCount(all.length, itemCount) }
}
