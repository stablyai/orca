// A conversation's native chat (structured session): its deliveries, prompts, turns and Stop.
import { randomUUID } from 'node:crypto'
import {
  endedTurn,
  endedTurnAttribution,
  type EndedChatTurn
} from './external-conversation-ended-turn'
export type { EndedChatTurn } from './external-conversation-ended-turn'
import { readAgentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import type { AgentJournalTurnOutcome } from '../../shared/agent-status/lifecycle/agent-turn-outcome'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../shared/agent-session/agent-session-wire'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { connectorAskerPrompt, connectorPlainMessages } from '../../shared/connector-asker-prompt'
import { CHAT_GONE_REFUSAL } from '../../shared/connectors/connector-cloud-contract'
import { createStructuredAgentSessionOperationId } from '../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/agent-session/view/structured-agent-session-projection'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import {
  getStructuredAgentSessionHost,
  onStructuredAgentSessionHostChanged
} from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  sendAgentTurn,
  type StructuredAgentTurnHost
} from '../runtime/orchestration/turn-delivery/send-agent-turn'
import { refusalOf } from './external-conversation-chain'
import { storedConnectorAsker } from '../../shared/connector-message-asker'
import { connectorFailure } from './external-conversation-failure'
import { refused, type ConnectorMessage, type Delivery } from './external-conversation-types'

/** What the seam reads of the native-chat host. */
export type ConversationChat = StructuredAgentTurnHost &
  Pick<
    StructuredAgentSessionHost,
    | 'respondToPrompt'
    | 'cancel'
    | 'subscribeTurnCompletions'
    | 'journalReads'
    | 'currentWork'
    | 'publishedWork'
    | 'conversation'
  > & {
    reads: Pick<StructuredAgentSessionHost['reads'], 'childWork'>
    deps: { store: { getConversation(sessionId: string): { currentFence: number } | null } }
  }

/** The native-chat host is installed lazily and can be replaced, so readers follow it. */
export type ConversationChatHost = {
  current: () => ConversationChat | null
  /** Installs the host if needed; null when it cannot be. */
  ensure: () => Promise<ConversationChat | null>
  onChanged: (listener: () => void) => () => void
}

export function runtimeChatHost(runtime: {
  ensureStructuredAgentSessionHost: () => Promise<void>
}): ConversationChatHost {
  return {
    current: getStructuredAgentSessionHost,
    ensure: async () => {
      await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
      return getStructuredAgentSessionHost()
    },
    onChanged: onStructuredAgentSessionHostChanged
  }
}

export function currentChat(chats: ConversationChatHost | undefined): ConversationChat | null {
  return chats?.current() ?? null
}

/** A chat's prompt raised or turn ended, as its host's own feed reports it. */
export type ChatNews =
  | { kind: 'prompt'; sessionId: string }
  | { kind: 'closed'; sessionId: string }
  | {
      kind: 'turn-ended'
      sessionId: string
      outcome: AgentJournalTurnOutcome
      mergedTurnCount?: number
      /** Read in full from the journal, only for linked chats; the status row keeps a short preview. */
      readTurn: () => Promise<EndedChatTurn>
      /** Only whom the turn acts for (its opener and the deliveries it answered), read by index. */
      readAttribution?: () => Promise<Pick<EndedChatTurn, 'opener' | 'stamps'>>
      at: number
    }

/** Turn news skips chats on purpose; their host's feed is the source, followed across reinstalls. */
export function watchChatNews(
  chats: ConversationChatHost,
  listener: (news: ChatNews) => void,
  id = 'external-conversations'
): () => void {
  const subscribe = (chat: ConversationChat | null): (() => void) =>
    chat?.subscribeTurnCompletions({
      id,
      includePrompts: true,
      onClosed: (sessionId) => listener({ kind: 'closed', sessionId }),
      emit: (event) => {
        if (event.type === 'prompt') {
          listener({ kind: 'prompt', sessionId: event.prompt.sessionId })
        } else if (event.type === 'completion') {
          const { sessionId, outcome, completedAt } = event.completion
          listener({
            kind: 'turn-ended',
            sessionId,
            outcome,
            ...(event.completion.mergedTurnCount !== undefined
              ? { mergedTurnCount: event.completion.mergedTurnCount }
              : {}),
            readTurn: () =>
              endedTurn(chat, sessionId, event.completion.turnId, event.completion.journalCursor),
            readAttribution: () =>
              endedTurnAttribution(
                chat,
                sessionId,
                event.completion.turnId,
                event.completion.journalCursor
              ),
            at: completedAt
          })
        }
      }
    }) ?? (() => {})
  let release = subscribe(chats.current())
  const stopFollowing = chats.onChanged(() => {
    release()
    release = subscribe(chats.current())
  })
  return () => {
    stopFollowing()
    release()
  }
}

/** The pane key the chat's status row is published under. */
export function chatPaneKey(sessionId: string): string {
  return structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
}

export function callerFor(link: Pick<ExternalConversationLink, 'sessionId'>): {
  callerKey: string
} {
  return { callerKey: `trusted-local:connector:${link.sessionId}` }
}

export function envelope(
  chat: ConversationChat,
  link: Pick<ExternalConversationLink, 'sessionId'>,
  method: string,
  fields: Record<string, unknown>
): AgentSessionMutationEnvelope | null {
  const conversation = chat.deps.store.getConversation(link.sessionId)
  if (!conversation) {
    return null
  }
  return {
    sessionId: link.sessionId,
    clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
    expectedRuntimeFence: conversation.currentFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: link.sessionId,
      fields
    })
  }
}

/** Sent as a person's message would be: a busy chat takes it into the running turn. A bot's is
 *  labelled with who asked, where and what came before; the chat shows the message alone. */
export async function deliverToChat(
  chat: ConversationChat | null,
  link: ExternalConversationLink,
  // admitted: told the moment the chat takes the message, before its turn can begin.
  delivery: ConnectorMessage & {
    signal: AbortSignal
    admitted?: () => void
    deliveryId?: string
    images?: readonly string[]
  }
): Promise<Delivery> {
  const { asker } = delivery
  const { note } = delivery
  const text = asker
    ? connectorAskerPrompt(link.source, asker, note, delivery)
    : connectorPlainMessages([delivery, ...(delivery.later ?? [])], note)
  // Kept beside the message for the chat's tag, with only the links a tag may open or fetch.
  const stored = asker ? storedConnectorAsker(link.source, asker) : undefined
  const { signal } = delivery
  if (!chat) {
    return refused('agent_not_reachable')
  }
  const record = chat.deps.store.getConversation(link.sessionId)
  // Its chat was deleted: the conversation may start a new one.
  if (!record) {
    return refused(CHAT_GONE_REFUSAL)
  }
  const fence = record.currentFence
  let admitted = false
  try {
    const outcome = await sendAgentTurn({
      kind: 'structured-session',
      host: chat,
      sessionId: link.sessionId,
      callerKey: callerFor(link).callerKey,
      // Admission is the receipt; the host's feed tells how the turn went.
      budgetMs: 0,
      turn: {
        body: {
          kind: 'message',
          role: 'user',
          // Its images ride as a person's attached ones would; the chat shows them with the message.
          blocks: [
            { type: 'text', text },
            ...(delivery.images ?? []).map((path) => ({ type: 'image-ref' as const, path }))
          ],
          // An event no one asked through is the connector's too, so the turn finds its conversation;
          // a bot's message whose asker didn't parse is someone unknown's, never the owner's.
          ...(asker || delivery.memorySource || link.bot ? { origin: 'connector' as const } : {}),
          ...(stored ? { asker: stored } : {}),
          // Whose delivery this is, kept with it: a prompt its turn raises is that conversation's.
          ...(link.bot
            ? { connectorConversation: { source: link.source, externalId: link.externalId } }
            : {}),
          // Its reply outbox rows commit with this admission (design item 125).
          ...(delivery.reply && delivery.deliveryId
            ? {
                connectorDelivery: {
                  account: delivery.reply.account,
                  conversation: { source: link.source, externalId: link.externalId },
                  deliveryId: delivery.deliveryId,
                  ...(delivery.reply.carried?.length ? { carried: delivery.reply.carried } : {})
                }
              }
            : {}),
          ...(delivery.memorySource ? { memorySource: delivery.memorySource } : {})
        },
        operationId: createStructuredAgentSessionOperationId(randomUUID),
        expectedRuntimeFence: fence,
        delivery: 'now',
        personsMessage: true,
        // Runs synchronously at admission, so a disable cannot interleave before the send.
        beforeRun: () => {
          if (signal.aborted) {
            throw new Error(refusalOf(signal))
          }
          admitted = true
          delivery.admitted?.()
        }
      }
    })
    if (outcome.kind === 'refused') {
      return refused('agent_not_reachable')
    }
    const dispatched = outcome.kind === 'sent' ? outcome.submission?.dispatchState : 'accepted'
    if (dispatched === 'rejected') {
      // Why the agent couldn't take it (signed out, not installed…), for the connector to say.
      const fact = readAgentSessionFailureFact(
        outcome.kind === 'sent' ? outcome.submission?.rejection : undefined
      )
      return refused('agent_not_reachable', fact && connectorFailure(fact, link.agent))
    }
    return dispatched === 'unknown'
      ? { outcome: 'unknown', reason: 'writer_failed' }
      : { outcome: 'accepted' }
  } catch {
    if (admitted) {
      return { outcome: 'unknown', reason: 'writer_failed' }
    }
    return refused(signal.aborted ? refusalOf(signal) : 'agent_not_reachable')
  }
}

/** Neither working nor waiting on a prompt; an uninstalled chat runs nothing. */
export function chatIsIdle(chat: ConversationChat | null, sessionId: string): boolean {
  const work = chat?.publishedWork(sessionId)
  return !work || (!work.working && !work.actionablePrompts.length)
}

/** The chat's own Stop, which also settles a pending prompt; an idle or uninstalled chat has nothing to stop. */
export async function stopChat(
  chat: ConversationChat | null,
  link: Pick<ExternalConversationLink, 'sessionId'>,
  signal?: AbortSignal
): Promise<Delivery> {
  const work = await chat?.currentWork(link.sessionId)
  if (!chat || !work || (!work.working() && !work.hasActionablePrompt())) {
    return { outcome: 'accepted' }
  }
  const mutation = envelope(chat, link, 'agentSession.cancel', {})
  if (!mutation) {
    return refused('agent_not_reachable')
  }
  if (signal?.aborted) {
    return refused(refusalOf(signal))
  }
  try {
    const result = await chat.cancel(callerFor(link), { envelope: mutation })
    return result.ok ? { outcome: 'accepted' } : refused('agent_not_reachable')
  } catch {
    return { outcome: 'unknown', reason: 'writer_failed' }
  }
}
