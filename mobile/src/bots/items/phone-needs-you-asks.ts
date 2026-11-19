// Orca's asks as the phone lists them in Needs you: the chats waiting on the owner and their workers,
// read from the chats tree it already has, and the access requests waiting on the bot. Sign-ins stay on
// the desktop for now, so the phone's count can be lower than the desktop's.
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import * as z from 'zod'
import type { AgentSessionAwaitedApproval } from '../../../../src/shared/agent-session/agent-session-wire'
import type { ConnectorAccessRequest } from '../../../../src/shared/connector-bot-access-contract'
import { accessRequestPerson } from '../../../../src/shared/bots/bot-access-request'
import type { BotChatTreeChat, BotChatTreeWorker } from '../../../../src/shared/bots/bot-chat-tree'
import { botItemsByDispatch } from '../../../../src/shared/bots/bot-item-groups'
import type { BotItem } from '../../../../src/shared/bots/bot-items'
import { botNeedsYouCount } from '../../../../src/shared/bots/bot-now'
import { useOptionalHostProtocolGates } from '../../components/host-connection/host-protocol-gates-context'
import { structuredAgentSessionHostSupport } from '../../session/native-chat/agent-session/mobile-structured-agent-session-host-support'
import { mobileStructuredSessionStatusFeed } from '../../session/native-chat/agent-session/mobile-structured-session-status-feed'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { BotAccessRequests } from '../use-bot-access-requests'

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
  /** The chat it belongs to, for the chat filter; null for an access request, which is no chat's. */
  chatId: string | null
  /** What a tap opens; null when the phone can't reach it. */
  open:
    | { chat: BotChatTreeChat }
    | { worker: BotChatTreeWorker }
    | { access: ConnectorAccessRequest }
    | null
}

/** What the activity read says of a worker: its dot and the tool its permission prompt asks for. */
export type PhoneWorkerAsk = { dot: string; tool?: { name: string; input: string | null } }

/** Approvals first, then the rest: chats and their workers in the tree's order (needs-you first, then
 *  newest), then access requests, as the desktop lists them. */
export function phoneNeedsYouAsks(
  chats: readonly BotChatTreeChat[],
  workerAsk: (dispatchId: string) => PhoneWorkerAsk | null,
  itemOf: (dispatchId: string) => Pick<BotItem, 'title' | 'number'> | null,
  chatApproval: (chat: BotChatTreeChat) => AgentSessionAwaitedApproval | undefined,
  accessRequests: readonly ConnectorAccessRequest[]
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
  for (const request of accessRequests) {
    asks.push({
      key: `access:${request.requestId}`,
      approval: false,
      title: accessRequestPerson(request),
      worker: null,
      number: null,
      tool: null,
      chatId: null,
      open: { access: request }
    })
  }
  return [...asks.filter((ask) => ask.approval), ...asks.filter((ask) => !ask.approval)]
}

/** The phone's existing openers: a chat from the tree, a worker where the tree or its host finds it. */
export type PhoneAskOpeners = {
  chat: (chat: BotChatTreeChat) => void
  worker: (worker: BotChatTreeWorker) => void
  access: (request: ConnectorAccessRequest) => void
}

export function openPhoneAsk(ask: PhoneAsk, openers: PhoneAskOpeners): void {
  if (!ask.open) {
    return
  }
  if ('chat' in ask.open) {
    openers.chat(ask.open.chat)
  } else if ('worker' in ask.open) {
    openers.worker(ask.open.worker)
  } else {
    openers.access(ask.open.access)
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

/** Every ask the phone reads, and the tab's count: those asks plus `itemCount`.
 *  It is what the phone lists, so it is lower than the desktop's when a sign-in waits. */
export function usePhoneNeedsYouAsks({
  client,
  chats,
  workers,
  items,
  access,
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
      accessRequests ?? []
    )
  }, [chats, workers, items, chatApproval, accessRequests])
  return { asks: all, count: botNeedsYouCount(all.length, itemCount) }
}
