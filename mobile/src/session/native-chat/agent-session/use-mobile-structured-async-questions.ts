import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { asyncQuestionSourceScope } from '../../../../../src/shared/native-chat/input/native-chat-ask'
import { AGENT_SESSION_SKIP_ASYNC_QUESTIONS_RUNTIME_CAPABILITY } from '../../../../../src/shared/agent-session/capabilities/agent-session-runtime-capabilities'
import { useRouteRelaysCapability } from '../../../worktree/execution-hosts/workspace-server-context'
import { mobileStructuredSessionStatusFeed } from './mobile-structured-session-status-feed'
import { callAgentSession } from './mobile-structured-agent-session-rpc'
import type { MobileStructuredAgentSessionArgs } from './mobile-structured-agent-session-contract'
import type { AgentSessionAwaitedQuestion } from '../../../../../src/shared/agent-session/agent-session-wire'

export type MobileStructuredAsyncQuestionSkip = {
  skippedThrough: string | undefined
  /** The open question the host waits on, for a phone that has not loaded its row. */
  awaiting: AgentSessionAwaitedQuestion | undefined
  /** Absent where a paired desktop relays the route without passing Skip on. */
  save?: (itemId: string) => Promise<unknown>
}

const noSubscription = (): (() => void) => () => {}

/** Where the chat's async questions come from, and the Skip its host saved for every device
 *  (read from the status feed; null on an older host, which leaves Skip to this screen). */
export function useMobileStructuredAsyncQuestions(
  chat: Pick<
    MobileStructuredAgentSessionArgs,
    'client' | 'sessionId' | 'enabled' | 'hostSupport' | 'agent'
  >,
  epoch: string | null
): {
  asyncQuestionSourceScope: string
  asyncQuestionSkip: MobileStructuredAsyncQuestionSkip | null
} {
  const { client, sessionId, hostSupport, agent } = chat
  // The feed keeps its summaries while the phone reconnects, so a saved Skip still holds then.
  const feed =
    chat.enabled &&
    client &&
    sessionId &&
    hostSupport?.statusFeed === true &&
    hostSupport.skipAsyncQuestions === true
      ? mobileStructuredSessionStatusFeed(client)
      : null
  const subscribe = useCallback(
    (listener: () => void) => (feed ? feed.subscribe(listener) : noSubscription()),
    [feed]
  )
  const read = useCallback(
    () =>
      feed && sessionId
        ? feed.getSnapshot().get(sessionId)?.asyncQuestionsSkippedThrough
        : undefined,
    [feed, sessionId]
  )
  const skippedThrough = useSyncExternalStore(subscribe, read, read)
  const readAwaiting = useCallback(
    () => (feed && sessionId ? feed.getSnapshot().get(sessionId)?.awaitsQuestion : undefined),
    [feed, sessionId]
  )
  const awaiting = useSyncExternalStore(subscribe, readAwaiting, readAwaiting)
  const save = useCallback(
    (itemId: string) =>
      client && sessionId
        ? callAgentSession(client, 'agentSession.skipAsyncQuestions', { sessionId, itemId })
        : Promise.reject(new Error('agent_session_unavailable')),
    [client, sessionId]
  )
  const relayed = useRouteRelaysCapability(AGENT_SESSION_SKIP_ASYNC_QUESTIONS_RUNTIME_CAPABILITY)
  const asyncQuestionSkip = useMemo(
    () => (feed ? { skippedThrough, awaiting, ...(relayed ? { save } : {}) } : null),
    [feed, skippedThrough, awaiting, relayed, save]
  )
  return {
    asyncQuestionSourceScope: asyncQuestionSourceScope({
      kind: 'journal',
      agent,
      sessionId,
      epoch
    }),
    asyncQuestionSkip
  }
}
