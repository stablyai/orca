// Orca's asks as the phone lists them in Needs you: the chats waiting on the owner and their workers,
// read from the chats tree it already has, the connectors that need a sign-in or fix, and the access
// requests waiting on the bot. Tool apps' sign-ins stay on the desktop for now, so the phone's count
// can be lower than the desktop's.
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import * as z from 'zod'
import type { AgentSessionAwaitedApproval } from '../../../../src/shared/agent-session/agent-session-wire'
import type { ConnectorAccessRequest } from '../../../../src/shared/connector-bot-access-contract'
import { accessRequestPerson } from '../../../../src/shared/bots/bot-access-request'
import type { BotChatTreeChat, BotChatTreeWorker } from '../../../../src/shared/bots/bot-chat-tree'
import {
  botItemsByDispatch,
  botItemsNeedingOwner
} from '../../../../src/shared/bots/bot-item-groups'
import type { BotItem } from '../../../../src/shared/bots/bot-items'
import { botNeedsYouCount } from '../../../../src/shared/bots/bot-now'
import { useOptionalHostProtocolGates } from '../../components/host-connection/host-protocol-gates-context'
import { structuredAgentSessionHostSupport } from '../../session/native-chat/agent-session/mobile-structured-agent-session-host-support'
import { mobileStructuredSessionStatusFeed } from '../../session/native-chat/agent-session/mobile-structured-session-status-feed'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { BotAccessRequests } from '../use-bot-access-requests'
import {
  usePhoneConnectorNeeds,
  type PhoneConnectorNeed
} from '../connectors/phone-connector-needs'
import type { RouteBot } from '../use-route-bot'
import type { PhoneBotItems } from './use-phone-bot-items'

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
  /** What a tap opens; null when the phone can't reach it. */
  open:
    | { chat: BotChatTreeChat }
    | { worker: BotChatTreeWorker }
    | { access: ConnectorAccessRequest }
    | { connector: PhoneConnectorNeed }
    /** An automation whose newest run stopped for a sign-in: listed, never counted. */
    | { stopped: { automationId: string } }
    | null
}

/** Whether the ask counts toward Needs you: a run a sign-in stopped is context for the sign-in. */
export function phoneAskCounts(ask: PhoneAsk): boolean {
  return !(ask.open && 'stopped' in ask.open)
}

/** What the activity read says of a worker: its dot and the tool its permission prompt asks for. */
export type PhoneWorkerAsk = { dot: string; tool?: { name: string; input: string | null } }

/** Approvals first, then the rest: chats and their workers in the tree's order (needs-you first, then
 *  newest), then connectors, then access requests, as the desktop lists them. */
export function phoneNeedsYouAsks(
  chats: readonly BotChatTreeChat[],
  workerAsk: (dispatchId: string) => PhoneWorkerAsk | null,
  itemOf: (dispatchId: string) => Pick<BotItem, 'title' | 'number'> | null,
  chatApproval: (chat: BotChatTreeChat) => AgentSessionAwaitedApproval | undefined,
  connectors: readonly PhoneConnectorNeed[],
  accessRequests: readonly ConnectorAccessRequest[],
  /** Automations whose newest run stopped for a sign-in. */
  stoppedForSignIn: readonly { id: string; name: string }[]
): PhoneAsk[] {
  const asks: PhoneAsk[] = []
  for (const chat of chats) {
    if (chat.closed) {
      continue
    }
    if (chat.live === 'needs-you') {
      const approval = chatApproval(chat)
      asks.push({
        key: `chat:${chat.chatId}`,
        approval: approval !== undefined,
        title: chat.title,
        worker: null,
        number: null,
        tool: approval ? { name: approval.tool, input: approval.input ?? null } : null,
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
        // A handed agent with no Dispatch opens only where the tree placed it.
        open: worker.dispatchId || worker.worktreeId ? { worker } : null
      })
    }
  }
  for (const connector of connectors) {
    asks.push({
      key: `connector:${connector.key}`,
      approval: false,
      title: connector.title,
      worker: null,
      number: null,
      tool: null,
      open: { connector }
    })
  }
  for (const request of accessRequests) {
    asks.push({
      key: `access:${request.requestId}`,
      approval: false,
      title: accessRequestPerson(request),
      worker: null,
      number: null,
      tool: null,
      open: { access: request }
    })
  }
  // Runs don't name the connector, so with none needing the owner they are history, as on the desktop.
  for (const automation of connectors.length > 0 ? stoppedForSignIn : []) {
    asks.push({
      key: `stopped:${automation.id}`,
      approval: false,
      title: automation.name,
      worker: null,
      number: null,
      tool: null,
      open: { stopped: { automationId: automation.id } }
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
  connector?: (need: PhoneConnectorNeed) => void
  /** The automation's runs; absent where no stopped run is listed. */
  stopped?: (automationId: string) => void
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
  } else if ('connector' in ask.open) {
    openers.connector?.(ask.open.connector)
  } else {
    openers.stopped?.(ask.open.stopped.automationId)
  }
}

const noSubscription = (): (() => void) => () => {}

// The waiting chats' approvals as `useChatApprovals` reads them: [session id, approval] pairs.
const ChatApprovals = z.array(
  z.tuple([z.string(), z.object({ tool: z.string(), input: z.string().optional() })])
)

/** The session whose status is the chat's: the one a /clear moved it to, else its own. */
export function chatSessionId(chat: BotChatTreeChat): string {
  return chat.liveSessionId ?? chat.chatId
}

/** The approval each waiting chat's session waits on, as its host's status feed says; none on a host
 *  without it. Read as one string, so other sessions' frames re-render nothing. */
function useChatApprovals(
  client: RpcClient | null,
  chats: readonly BotChatTreeChat[] | null
): (chat: BotChatTreeChat) => AgentSessionAwaitedApproval | undefined {
  const capabilities = useOptionalHostProtocolGates()?.hostCapabilities
  const statusFeed = useMemo(
    () => structuredAgentSessionHostSupport(capabilities ?? []).statusFeed,
    [capabilities]
  )
  const feed = client && statusFeed ? mobileStructuredSessionStatusFeed(client) : null
  const waiting = useMemo(
    () => (chats ?? []).filter((chat) => chat.live === 'needs-you').map(chatSessionId),
    [chats]
  )
  const subscribe = useCallback(
    (listener: () => void) => (feed ? feed.subscribe(listener) : noSubscription()),
    [feed]
  )
  const read = useCallback(() => {
    const snapshot = feed?.getSnapshot()
    return JSON.stringify(
      waiting.flatMap((id) => {
        const approval = snapshot?.get(id)?.awaitsApproval
        return approval ? [[id, approval]] : []
      })
    )
  }, [feed, waiting])
  const approvals = useSyncExternalStore(subscribe, read, read)
  return useMemo(() => {
    const byId = new Map(ChatApprovals.parse(JSON.parse(approvals)))
    return (chat: BotChatTreeChat) => byId.get(chatSessionId(chat))
  }, [approvals])
}

const NO_CONNECTORS: readonly PhoneConnectorNeed[] = []

/** Every ask the phone reads, and the tab's count: those asks plus `itemCount`. */
export function usePhoneNeedsYouAsks({
  client,
  chats,
  workers,
  items,
  access,
  connectors = NO_CONNECTORS,
  automations,
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
  /** The activity read's automations, for the runs a sign-in stopped. */
  automations?: readonly { automation: { id: string; name: string }; needsSignIn?: boolean }[]
  /** Needs you items that aren't stale, unfiltered. */
  itemCount: number
}): { asks: readonly PhoneAsk[]; count: number } {
  const chatApproval = useChatApprovals(client, chats)
  const accessRequests = access?.requests
  const all = useMemo(() => {
    const byDispatch = botItemsByDispatch(items ?? [])
    const seen = new Map((workers ?? []).map((row) => [row.key, row]))
    return phoneNeedsYouAsks(
      chats ?? [],
      (dispatchId) => seen.get(`worker:${dispatchId}`) ?? null,
      (dispatchId) => byDispatch.get(dispatchId) ?? null,
      chatApproval,
      connectors,
      accessRequests ?? [],
      (automations ?? []).flatMap((row) => (row.needsSignIn ? [row.automation] : []))
    )
  }, [chats, workers, items, chatApproval, connectors, accessRequests, automations])
  return { asks: all, count: botNeedsYouCount(all.filter(phoneAskCounts).length, itemCount) }
}

/** The bot panel's asks and Items tab count: with its connectors and the runs a sign-in stopped. */
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
    automations: routeBot.activity?.automations,
    // A first read that failed counts no items, as nothing was read; the bot list's count stands
    // in until one lands.
    itemCount: read
      ? botItemsNeedingOwner(read, staleDays, now)
      : items.error !== null
        ? 0
        : panel.listNeedsYou
  })
}
