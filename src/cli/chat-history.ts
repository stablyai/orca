import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryResult
} from '../shared/agent-session/agent-session-wire'
import type { AgentSessionWorkState } from '../shared/agent-session/agent-session-work-state'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../shared/agent-session/agent-session-wire'
import {
  AGENT_SESSION_UNATTACHED_REFUSAL_CODE,
  isUnattachedAgentSessionReadRefusal
} from '../shared/agent-session/failures/structured-agent-session-read-refusal'
import { structuredAgentSessionQueueSendsNext } from '../shared/agent-session/view/structured-agent-session-live-turn'
import { chatTranscript, formatChatRead, type ChatTranscriptEntry } from './chat-sessions'
import type { RuntimeClient, RuntimeRpcSuccess } from './runtime-client'
import { RuntimeClientError } from './runtime-client'

export const DEFAULT_READ_LIMIT = 20
const WAIT_POLL_MS = 1000

export type ChatTranscript = {
  session: string
  entries: ChatTranscriptEntry[]
  /** Newest journal row read, so a later `--since` can continue from it. */
  cursor: AgentSessionHistoryPage['window']['newest']
  /** Older rows exist that this 200-row read did not reach, and they were needed. */
  truncated: boolean
}
/** The chat's own turn in `chat list` words (structuredAgentSessionLeadState), plus two wait-only outcomes. */
export type ChatSettled = 'done' | 'blocked' | 'held' | 'timeout'

export async function readHistory(
  client: RuntimeClient,
  session: string,
  limit: number
): Promise<RuntimeRpcSuccess<AgentSessionHistoryResult>> {
  return client
    .call<AgentSessionHistoryResult>('agentSession.history', {
      sessionId: session,
      direction: 'tail',
      limit
    })
    .catch((error: unknown) => {
      throw explainChatRefusal(error, session, 'read')
    })
}

export async function readTranscript(
  client: RuntimeClient,
  session: string,
  limit?: number
): Promise<RuntimeRpcSuccess<ChatTranscript>> {
  // Status frames and turn markers share the journal, so read the most rows a page allows.
  const response = await readHistory(client, session, AGENT_SESSION_HISTORY_MAX_LIMIT)
  const { page } = response.result
  const all = chatTranscript(page.items, page.actionablePromptIds)
  const entries = limit === undefined ? all : all.slice(-limit)
  const truncated = page.hasOlder && (limit === undefined || all.length < limit)
  return { ...response, result: { session, entries, cursor: page.window.newest, truncated } }
}

/** Older hosts' history pages may omit `working`. */
export type ChatWorkState = Omit<AgentSessionWorkState, 'working'> & { working?: boolean }

/** One command's reads of the facts a send or wait decides from. Hosts without
 *  `agentSession.workState` answer from a history page for the rest of the command. */
export function chatWorkStateReader(
  client: RuntimeClient,
  session: string
): () => Promise<ChatWorkState> {
  let historyOnly = false
  return async () => {
    if (!historyOnly) {
      try {
        const response = await client.call<AgentSessionWorkState>('agentSession.workState', {
          sessionId: session
        })
        return response.result
      } catch (error) {
        if (!(error instanceof RuntimeClientError && error.code === 'method_not_found')) {
          throw explainChatRefusal(error, session, 'read')
        }
        historyOnly = true
      }
    }
    const { page } = (await readHistory(client, session, 1)).result
    return {
      ...(page.working !== undefined ? { working: page.working } : {}),
      actionablePrompt: (page.actionablePromptIds?.length ?? 0) > 0,
      ...(page.queuedMessages !== undefined
        ? { queuedMessageIds: (page.queuedMessages ?? []).map((m) => m.messageId) }
        : {}),
      nextQueuedMessageId: page.nextQueuedMessageId ?? null,
      ...(page.fence !== undefined ? { fence: page.fence } : {})
    }
  }
}

export function requireWorkingFlag(state: { working?: boolean }): void {
  if (state.working === undefined) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca host does not report when a chat is working, so it cannot wait. Update Orca on the host.'
    )
  }
}

// Settled means no running turn or unanswered send, or a question/approval waiting for the user.
export async function waitForChat(
  readWorkState: () => Promise<ChatWorkState>,
  timeoutMs: number | undefined,
  queuedMessageId?: string
): Promise<ChatSettled> {
  const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs
  for (;;) {
    const state = await readWorkState()
    requireWorkingFlag(state)
    if (state.actionablePrompt) {
      return 'blocked'
    }
    // Between turns the host names its next automatic send while working is briefly false.
    const sendsNext = structuredAgentSessionQueueSendsNext(
      state.nextQueuedMessageId,
      state.working === true
    )
    if (!state.working && !sendsNext) {
      // Still queued with nothing running or about to send: stopped, failed or held across a reopen.
      const held =
        queuedMessageId !== undefined && state.queuedMessageIds?.includes(queuedMessageId) === true
      return held ? 'held' : 'done'
    }
    if (Date.now() >= deadline) {
      return 'timeout'
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS))
  }
}

// After a wait, the turn's entries: everything after the last user message.
export async function readSettledTurn(
  client: RuntimeClient,
  session: string,
  settled: ChatSettled
): Promise<RuntimeRpcSuccess<ChatTranscript & { settled: ChatSettled }>> {
  if (settled === 'timeout' || settled === 'held') {
    // Chained commands such as `send --wait && ...` need a failing exit when the chat did not settle.
    process.exitCode = 1
  }
  const response = await readTranscript(client, session)
  const { entries, truncated } = response.result
  const lastUser = entries.findLastIndex((e) => e.kind === 'message' && e.role === 'user')
  // A held message never ran, so the last turn on the page is not its reply.
  const turn = settled === 'held' ? [] : entries.slice(lastUser + 1)
  return {
    ...response,
    result: {
      ...response.result,
      entries: turn,
      truncated: settled !== 'held' && truncated && lastUser === -1,
      settled
    }
  }
}

export function formatSettled(result: ChatTranscript & { settled: ChatSettled }): string {
  const status =
    result.settled === 'timeout'
      ? 'Still working when the wait timed out.'
      : result.settled === 'held'
        ? 'Your message is held in the queue (the chat was stopped or the send failed). Resume it in Orca.'
        : result.settled === 'blocked'
          ? 'Blocked: waiting for you to answer an approval or question.'
          : 'Done.'
  return result.entries.length === 0 ? status : `${formatChatRead(result)}\n${status}`
}

// The host answers with bare wire codes; say what they mean for this command.
export function explainChatRefusal(
  error: unknown,
  sessionId: string,
  action: 'rename' | 'read' | 'send to'
): unknown {
  if (!(error instanceof RuntimeClientError)) {
    return error
  }
  if (error.message === 'agent_session_identity_required') {
    return new RuntimeClientError(
      'agent_session_identity_required',
      `No chat with session id ${sessionId} on this host.`
    )
  }
  if (isUnattachedAgentSessionReadRefusal(error)) {
    return new RuntimeClientError(
      AGENT_SESSION_UNATTACHED_REFUSAL_CODE,
      `No open chat with session id ${sessionId} on this host. Find it with \`orca chat list\`.`
    )
  }
  if (
    error.message === 'structured_agent_session_unsupported' ||
    error.code === 'method_not_found'
  ) {
    return new RuntimeClientError(
      'incompatible_runtime',
      `This Orca host cannot ${action} chats from the CLI. Update Orca on that host, or check that it has chats turned on.`
    )
  }
  return error
}
