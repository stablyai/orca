// The user's Delete chat: stop the chat, then one locked store commit forgets every session of its
// /clear lineage and writes its tombstone. From then on nothing opens, sends to, lists or adopts it;
// its journal rows page out in the background. Workers it started, memory, items, connector threads
// and the agent's own transcript stay.
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { isOrcaSessionId } from '../../../shared/agent-session/identity/orca-session-address'
import { isBotGroupMemberSession } from '../../../shared/bots/bot-group'
import type { OrcaChatDeleteResult } from '../../../shared/agent-session/chat-deletion/orca-chat-delete'
import { createCanonicalOrcaSessionResolver } from '../../runtime/orchestration/addressing/session-lineage/canonical-orca-session-id'
import { readAgentSessionRecordStore } from '../../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { dropUnreadBotRequests } from '../../runtime/rpc/methods/orchestration/messaging/bot-request-outcome'
import { structuredAgentRuntimeMetadata } from '../../runtime/agent-session/installation/structured-agent-runtime-metadata'
import { closeStructuredAgentSessionChild } from '../../runtime/agent-session/lifecycle/structured-agent-session-close'
import { botOfSession } from '../../bots/bot-session-tabs'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { DeletedChatConversation } from './deleted-chats'
import { getStructuredAgentSessionHost } from '../agent-session-wire/host/structured-agent-session-registry'
import { withdrawClientAsksOf } from '../../runtime/orchestration/federation/client-asks/client-ask-queue'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../shared/agent-session/identity/orca-session-address-prefix'
import { retireChatRuns } from '../../runtime/orchestration/db/runs/retired-chat-runs'

type ChatHost = NonNullable<ReturnType<typeof getStructuredAgentSessionHost>>

// A send that reopens the chat between its stop and the commit is stopped again, this many times.
const STOP_ATTEMPTS = 3

/** The chat a session belongs to: every record its /clear lineage shares, keyed by its first. */
function chatLineage(
  host: ChatHost,
  sessionId: string
): { root: string; records: AgentSessionRecord[] } | null {
  const { store } = host.deps
  if (!store.getRecord(sessionId)) {
    return null
  }
  const resolve = createCanonicalOrcaSessionResolver(readAgentSessionRecordStore())
  const rootOf = (id: string) => (isOrcaSessionId(id) ? resolve(id) : id)
  const root = rootOf(sessionId)
  return {
    root,
    records: store.listRecords().filter((record) => rootOf(record.sessionId) === root)
  }
}

/** Every provider conversation the chat's records name, as Session History rows them. */
function chatConversations(records: readonly AgentSessionRecord[]): DeletedChatConversation[] {
  const conversations = new Map<string, DeletedChatConversation>()
  for (const { provider, providerHandleChain } of records) {
    const history = structuredAgentRuntimeMetadata(provider)?.sessionHistory
    for (const link of providerHandleChain) {
      const providerSessionId = history ? history.rowSessionId(link) : link.handle.nativeId
      conversations.set(`${provider}\0${providerSessionId}`, { provider, providerSessionId })
    }
  }
  return [...conversations.values()]
}

/** A worker chat an orchestration still waits on settles through its record. */
const ownsOpenDispatch = (host: ChatHost, records: readonly AgentSessionRecord[]): boolean =>
  records.some((record) => host.deps.hasOpenDispatch?.(record) === true)

/** Holds every session's conversation lane, in a fixed order so two deletes never deadlock. */
function inLanes<T>(
  host: ChatHost,
  sessionIds: readonly string[],
  work: () => Promise<T>
): Promise<T> {
  const [first, ...rest] = [...sessionIds].sort()
  return first === undefined ? work() : host.serialize(first, () => inLanes(host, rest, work))
}

type Commit = 'forgotten' | 'reopened' | 'refused' | 'worker'

/** Inside every lane nothing can load the chat or start a turn: forget the lineage in one commit. */
function commitChatDeletion(
  host: ChatHost,
  chatId: string,
  records: readonly AgentSessionRecord[]
): Promise<Commit> {
  const sessionIds = records.map((record) => record.sessionId)
  return inLanes(host, sessionIds, async (): Promise<Commit> => {
    if (sessionIds.some(host.hasSession)) {
      return 'reopened'
    }
    // Read again in the lanes: a send since the first read may have added a provider conversation.
    const current = sessionIds.flatMap((id) => host.deps.store.getRecord(id) ?? [])
    if (ownsOpenDispatch(host, current)) {
      return 'worker'
    }
    const forgotten = await host.deps.store
      .forgetChat({ chatId, sessionIds, conversations: chatConversations(current) })
      .catch((error: unknown) => {
        console.warn('[chat-delete] the chat store refused the delete', error)
        return false
      })
    return forgotten ? 'forgotten' : 'refused'
  })
}

/** Stops each loaded session of the chat, running or not, and closes its tab on every client. */
async function stopChat(
  runtime: OrcaRuntimeService,
  host: ChatHost,
  records: readonly AgentSessionRecord[]
): Promise<boolean> {
  for (const { sessionId } of records) {
    if (host.hasSession(sessionId) || host.isSessionTabVisible(sessionId)) {
      const closed = await closeStructuredAgentSessionChild(sessionId, { runtime })
      if (!closed.stopped) {
        console.warn('[chat-delete] could not stop the chat', closed.reason)
        return false
      }
    }
  }
  return true
}

/** Deletes the chat `sessionId` belongs to, stopping it first when it runs. */
export async function deleteOrcaChat(
  runtime: OrcaRuntimeService,
  sessionId: string
): Promise<OrcaChatDeleteResult> {
  await runtime.ensureStructuredAgentSessionHost()
  const host = getStructuredAgentSessionHost()
  if (!host || host.deps.store.readOnly) {
    return { outcome: 'refused', reason: 'unavailable' }
  }
  const chat = chatLineage(host, sessionId)
  if (!chat) {
    return { outcome: 'refused', reason: 'not-found' }
  }
  // A group room routes its messages to each member's session, so a member's chat isn't one to delete.
  if (chat.records.some((record) => isBotGroupMemberSession(record.sessionId))) {
    return { outcome: 'refused', reason: 'group' }
  }
  const bot = botOfSession(runtime.bots, chat.root)
  // A managed agent's live Home is where its mail and connectors land; it is not deleted.
  if (chat.records.some((record) => record.sessionId === bot?.chatSessionId)) {
    return { outcome: 'refused', reason: 'home' }
  }
  // Before any stop, so a refused delete never interrupts a worker's turn.
  if (ownsOpenDispatch(host, chat.records)) {
    return { outcome: 'refused', reason: 'workers' }
  }
  let committed: Commit = 'reopened'
  for (let attempt = 0; attempt < STOP_ATTEMPTS && committed === 'reopened'; attempt++) {
    if (!(await stopChat(runtime, host, chat.records))) {
      return { outcome: 'refused', reason: 'unavailable' }
    }
    committed = await commitChatDeletion(host, chat.root, chat.records)
  }
  if (committed !== 'forgotten') {
    return { outcome: 'refused', reason: committed === 'worker' ? 'workers' : 'unavailable' }
  }
  // What it asked agents on paired computers is withdrawn: no one is left to read the answers.
  withdrawClientAsksOf(
    runtime,
    chat.records.map((record) => `${ORCA_SESSION_ADDRESS_PREFIX}${record.sessionId}`)
  )
  for (const record of chat.records) {
    // It never reads for its Runs again: their open worker asks are told now.
    retireChatRuns(runtime, record.sessionId)
  }
  if (bot) {
    for (const record of chat.records) {
      // Mail it never read goes unanswered, and its senders hear so.
      await dropUnreadBotRequests(runtime, bot.id, 'chat-deleted', record.sessionId)
    }
  }
  return { outcome: 'deleted' }
}
