// A conversation's native chat (structured session): its deliveries, prompts, turns and Stop.
import { randomUUID } from 'node:crypto'
import { isConversationReport } from './external-conversation-turn-opener'
import {
  endedTurn,
  endedTurnAttribution,
  type EndedChatTurn
} from './external-conversation-ended-turn'
export type { EndedChatTurn } from './external-conversation-ended-turn'
import type { AgentJournalTurnOutcome } from '../../shared/agent-status/lifecycle/agent-turn-outcome'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../shared/agent-session/agent-session-wire'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import {
  findLinkForSession,
  sameConversation,
  type ExternalConversationLinkStore
} from './external-conversation-links'
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
import type { StructuredAgentTurnHost } from '../runtime/orchestration/turn-delivery/send-agent-turn'
import { refusalOf } from './external-conversation-chain'
import { refused, type Delivery } from './external-conversation-types'

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
    deps: { store: { getConversation(sessionId: string): { currentFence: number } | null } }
    currentWorkAtRest?: (
      sessionId: string
    ) => Promise<Pick<
      NonNullable<Awaited<ReturnType<StructuredAgentSessionHost['currentWorkAtRest']>>>,
      'working' | 'owesAnySend' | 'hasActionablePrompt'
    > | null>
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

/** Whether mail finishing its conversation's ask (isConversationReport) opened the chat's running turn;
 *  read from its journal, so it holds across watches and restarts. */
export function runningTurnOpenedByConversationReport(
  chats: ConversationChatHost | undefined,
  sessionId: string
): boolean {
  const opener = currentChat(chats)?.publishedWork(sessionId)?.activeTurnOpener
  return opener ? isConversationReport(opener.body) : false
}

/** Whether a chat's running turn is its conversation's (conversationOwnsTurn): a delivery it took
 *  (`pending`), a continuation claiming the link's requests, or mail finishing its ask. */
export function chatTurnFacts(
  chats: ConversationChatHost | undefined,
  store: ExternalConversationLinkStore,
  pending: (sessionId: string) => boolean
) {
  // A continuation answering this link's requests a restart or usage limit cut: durable, unlike a
  // delivery's mark. One claiming another conversation's (the chat moved since) is not this one's.
  const claimed = (sessionId: string): boolean => {
    const opener = currentChat(chats)?.publishedWork(sessionId)?.activeTurnOpener
    const claim = opener?.body.kind === 'message' ? opener.body.connectorClaim : undefined
    const link = claim && findLinkForSession(store, sessionId)?.link
    return !!link && claim.origin.some((stamp) => sameConversation(link, stamp.conversation))
  }
  return {
    delivered: (sessionId: string) => pending(sessionId) || claimed(sessionId),
    reported: (sessionId: string) => runningTurnOpenedByConversationReport(chats, sessionId)
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
