// Orca's asks as the phone lists them in Needs you: the chats waiting on the owner and their workers,
// read from the chats tree it already has, the access requests waiting on the bot, paired servers'
// agents waiting to message it, and the connectors that need a sign-in or fix, as one ask.
import { useMemo } from 'react'
import type { ConnectorAccessRequest } from '../../../../src/shared/connector-bot-access-contract'
import { accessRequestPerson } from '../../../../src/shared/bots/bot-access-request'
import type { BotChatTreeChat, BotChatTreeWorker } from '../../../../src/shared/bots/bot-chat-tree'
import {
  botItemsByDispatch,
  botItemsNeedingOwner
} from '../../../../src/shared/bots/bot-item-groups'
import type { BotItem } from '../../../../src/shared/bots/bot-items'
import type { PairedServerAskCard } from '../../../../src/shared/rpc-contract/paired-server-asks-params'
import type { ConnectorPage } from '../connectors/connector-pages'
import { botNeedsYouCount } from '../../../../src/shared/bots/bot-now'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  pairedServerAskerName,
  useMobilePairedServerAsks
} from '../../session/native-chat/input/prompts/use-mobile-paired-server-asks'
import type { BotAccessRequests } from '../use-bot-access-requests'
import {
  usePhoneConnectorNeeds,
  type PhoneConnectorNeed
} from '../connectors/phone-connector-needs'
import type { RouteBot } from '../use-route-bot'
import type { PhoneBotItems } from './use-phone-bot-items'
import { useChatPrompts, type PhoneChatPrompt } from './use-phone-chat-prompts'

export type PhoneAsk = {
  key: string
  approval: boolean
  title: string
  /** The worker that asks, when the row takes its item's title. */
  worker: string | null
  /** That item's number. */
  number: number | null
  /** The tool an approval asks to run, when its chat's or worker's status says. */
  tool: { name: string; input: string | null } | null
  /** The question a chat's turn stopped for, when its host's status says. */
  question: string | null
  /** When it began asking, where the reads say. */
  at: number | null
  /** What a tap opens; null when the phone can't reach it. */
  open:
    | { chat: BotChatTreeChat }
    | { worker: BotChatTreeWorker }
    | { access: ConnectorAccessRequest }
    /** Every connector that needs a sign-in or fix, one row for them all. */
    | { connectors: readonly PhoneConnectorNeed[] }
    /** A paired server's agent waiting to message the bot: its card waits in the Home chat, null
     *  until the tree lists it. */
    | { pairedAsk: { card: PairedServerAskCard; home: BotChatTreeChat | null } }
    | null
}

/** What the activity read says of a worker: its dot and the tool its permission prompt asks for. */
export type PhoneWorkerAsk = { dot: string; tool?: { name: string; input: string | null } }

/** Approvals first, then the rest: chats and their workers in the tree's order (needs-you first, then
 *  newest), then access requests, then the connectors' one ask. */
export function phoneNeedsYouAsks(
  chats: readonly BotChatTreeChat[],
  workerAsk: (dispatchId: string) => PhoneWorkerAsk | null,
  itemOf: (dispatchId: string) => Pick<BotItem, 'title' | 'number'> | null,
  chatPrompt: (chat: BotChatTreeChat) => PhoneChatPrompt | undefined,
  connectors: readonly PhoneConnectorNeed[],
  accessRequests: readonly ConnectorAccessRequest[],
  pairedAsks: readonly PairedServerAskCard[] = []
): PhoneAsk[] {
  const asks: PhoneAsk[] = []
  for (const chat of chats) {
    if (chat.closed) {
      continue
    }
    const prompt = chat.live === 'needs-you' ? chatPrompt(chat) : undefined
    // The host marks Home as waiting while a paired server's card waits there: that card is its row,
    // unless Home's own session waits too (unknown without a status feed).
    const onlyPairedAsk = chat.origin === 'home' && pairedAsks.length > 0 && prompt?.own !== true
    if (chat.live === 'needs-you' && !onlyPairedAsk) {
      const approval = prompt?.awaitsApproval
      asks.push({
        key: `chat:${chat.chatId}`,
        approval: approval !== undefined,
        title: chat.title,
        worker: null,
        number: null,
        tool: approval ? { name: approval.tool, input: approval.input ?? null } : null,
        question: prompt?.awaitsBlockingQuestion?.text ?? null,
        at: chat.lastActiveAt > 0 ? chat.lastActiveAt : null,
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
        question: null,
        at: null,
        // A handed agent with no Dispatch opens only where the tree placed it.
        open: worker.dispatchId || worker.worktreeId ? { worker } : null
      })
    }
  }
  for (const request of accessRequests) {
    asks.push({
      key: `access:${request.requestId}`,
      approval: false,
      title: accessRequestPerson(request),
      worker: null,
      number: null,
      tool: null,
      question: null,
      at: request.createdAt,
      open: { access: request }
    })
  }
  const home = chats.find((chat) => chat.origin === 'home' && !chat.closed) ?? null
  for (const card of pairedAsks) {
    asks.push({
      key: `paired-ask:${card.messageId}`,
      // Its card always asks for a permission, as the desktop counts it.
      approval: true,
      title: pairedServerAskerName(card),
      worker: null,
      number: null,
      tool: null,
      question: null,
      at: Date.parse(card.createdAt) || null,
      open: { pairedAsk: { card, home } }
    })
  }
  if (connectors.length > 0) {
    asks.push({
      key: 'connectors',
      approval: false,
      title: connectors[0].title,
      worker: null,
      number: null,
      tool: null,
      question: null,
      at: null,
      open: { connectors }
    })
  }
  return [...asks.filter((ask) => ask.approval), ...asks.filter((ask) => !ask.approval)]
}

/** The phone's existing openers: a chat from the tree, a worker where the tree or its host finds it. */
export type PhoneAskOpeners = {
  chat: (chat: BotChatTreeChat) => void
  worker: (worker: BotChatTreeWorker) => void
  access: (request: ConnectorAccessRequest) => void
  /** Absent where no connector is listed, as in a group. */
  connector?: (page: ConnectorPage) => void
}

export function openPhoneAsk(ask: PhoneAsk, openers: PhoneAskOpeners): void {
  if (!ask.open) {
    return
  }
  if ('chat' in ask.open) {
    openers.chat(ask.open.chat)
  } else if ('worker' in ask.open) {
    openers.worker(ask.open.worker)
  } else if ('access' in ask.open) {
    openers.access(ask.open.access)
  } else if ('connectors' in ask.open) {
    // One opens its own page; several, the Connectors list that shows them all.
    const [only, ...rest] = ask.open.connectors
    openers.connector?.(rest.length === 0 && only ? only.page : { kind: 'list' })
  } else if (ask.open.pairedAsk.home) {
    // Its card waits docked in the Home chat.
    openers.chat(ask.open.pairedAsk.home)
  }
}

const NO_CONNECTORS: readonly PhoneConnectorNeed[] = []
const NO_PAIRED_ASKS: readonly PairedServerAskCard[] = []
// The panel lists the cards; they are answered in the Home chat.
const ignoreAnswerError = (): void => {}

/** Every ask the phone reads, and the tab's count: those asks plus `itemCount`. */
export function usePhoneNeedsYouAsks({
  client,
  chats,
  workers,
  items,
  access,
  connectors = NO_CONNECTORS,
  pairedAsks = NO_PAIRED_ASKS,
  itemCount
}: {
  /** The bot host's client, whose status feed says which chats wait on an approval; null while the
   *  panel is closed, so it reads none. */
  client: RpcClient | null
  /** The chats tree once read. */
  chats: readonly BotChatTreeChat[] | null
  /** The activity read's workers, for their dots and tools. */
  workers: readonly ({ key: string } & PhoneWorkerAsk)[] | undefined
  items: readonly BotItem[] | undefined
  /** The bot's waiting access requests; null without a route bot. */
  access: Pick<BotAccessRequests, 'requests'> | null
  /** Its connectors that need the owner; a group lists none. */
  connectors?: readonly PhoneConnectorNeed[]
  /** Paired servers' agents waiting to message the bot; a group lists none. */
  pairedAsks?: readonly PairedServerAskCard[]
  /** Needs you items that aren't stale, unfiltered. */
  itemCount: number
}): { asks: readonly PhoneAsk[]; count: number } {
  const chatPrompt = useChatPrompts(client, chats)
  const accessRequests = access?.requests
  const all = useMemo(() => {
    const byDispatch = botItemsByDispatch(items ?? [])
    const seen = new Map((workers ?? []).map((row) => [row.key, row]))
    return phoneNeedsYouAsks(
      chats ?? [],
      (dispatchId) => seen.get(`worker:${dispatchId}`) ?? null,
      (dispatchId) => byDispatch.get(dispatchId) ?? null,
      chatPrompt,
      connectors,
      accessRequests ?? [],
      pairedAsks
    )
  }, [chats, workers, items, chatPrompt, connectors, accessRequests, pairedAsks])
  return { asks: all, count: botNeedsYouCount(all.length, itemCount) }
}

/** The bot panel's asks and Items tab count, with its connectors. */
export function usePhonePanelNeedsYouAsks({
  client,
  chats,
  panel,
  items,
  staleDays,
  now
}: {
  /** As `usePhoneNeedsYouAsks`, and the client its connectors' reads go through: null under
   *  Settings too, which reads its own connectors (back from a fix there reads them again). */
  client: RpcClient | null
  chats: readonly BotChatTreeChat[] | null
  panel: {
    routeBot: Pick<RouteBot, 'bot' | 'activity' | 'reads' | 'hostKey'>
    hostName: string
    online: boolean
    accessRequests: Pick<BotAccessRequests, 'requests'> | null
    /** The Needs you count the bot list carries, until the panel reads the items. */
    listNeedsYou: number
  }
  items: Pick<PhoneBotItems, 'read' | 'error'>
  staleDays: number | null
  now: number
}): { asks: readonly PhoneAsk[]; count: number } {
  const { routeBot, hostName } = panel
  const read = items.read?.items
  return usePhoneNeedsYouAsks({
    client,
    chats,
    workers: routeBot.activity?.workers,
    items: read,
    access: panel.accessRequests,
    connectors: usePhoneConnectorNeeds({ client, hostName, ...routeBot }),
    pairedAsks: useMobilePairedServerAsks({
      client,
      connected: panel.online,
      botId: routeBot.bot.id,
      onAnswerError: ignoreAnswerError
    }).open,
    // A first read that failed counts no items, as nothing was read; the bot list's count stands
    // in until one lands.
    itemCount: read
      ? botItemsNeedingOwner(read, staleDays, now)
      : items.error !== null
        ? 0
        : panel.listNeedsYou
  })
}
