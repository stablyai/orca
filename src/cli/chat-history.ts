import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryResult
} from '../shared/agent-session/agent-session-wire'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../shared/agent-session/agent-session-wire'
import {
  AGENT_SESSION_UNATTACHED_REFUSAL_CODE,
  isUnattachedAgentSessionReadRefusal
} from '../shared/agent-session/failures/structured-agent-session-read-refusal'
import { chatTranscript, formatChatRead, type ChatTranscriptEntry } from './chat-sessions'
import type { RuntimeClient, RuntimeRpcSuccess } from './runtime-client'
import { RuntimeClientError } from './runtime-client'

export const DEFAULT_READ_LIMIT = 20
// Status frames and turn markers share the journal with the conversation, so fetch more rows than shown.
const HISTORY_ROWS_PER_ENTRY = 4
const WAIT_POLL_MS = 1000

export type ChatTranscript = {
  session: string
  entries: ChatTranscriptEntry[]
  /** Newest journal row read, so a later `--since` can continue from it. */
  cursor: AgentSessionHistoryPage['window']['newest']
}
export type ChatSettled = 'idle' | 'waiting' | 'held' | 'timeout'

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
  limit: number
): Promise<RuntimeRpcSuccess<ChatTranscript>> {
  const response = await readHistory(
    client,
    session,
    Math.min(limit * HISTORY_ROWS_PER_ENTRY, AGENT_SESSION_HISTORY_MAX_LIMIT)
  )
  const { page } = response.result
  const entries = chatTranscript(page.items).slice(-limit)
  return { ...response, result: { session, entries, cursor: page.window.newest } }
}

export function requireWorkingFlag(page: AgentSessionHistoryPage): void {
  if (page.working === undefined) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca host does not report when a chat is working, so it cannot wait. Update Orca on the host.'
    )
  }
}

// Settled means no running turn or unanswered send, or a question/approval waiting for the user.
export async function waitForChat(
  client: RuntimeClient,
  session: string,
  timeoutMs: number | undefined,
  queuedMessageId?: string
): Promise<ChatSettled> {
  const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs
  for (;;) {
    const { page } = (await readHistory(client, session, 1)).result
    requireWorkingFlag(page)
    if ((page.actionablePromptIds?.length ?? 0) > 0) {
      return 'waiting'
    }
    const queued = page.queuedMessages?.find((m) => m.messageId === queuedMessageId)
    if (!page.working && !queued) {
      return 'idle'
    }
    // A stopped queue or a failed card keeps the message until the user acts in Orca.
    if (!page.working && (page.queuePause || queued?.paused || queued?.state === 'returned')) {
      return 'held'
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
  const response = await readTranscript(client, session, DEFAULT_READ_LIMIT)
  const { entries } = response.result
  const lastUser = entries.findLastIndex((e) => e.kind === 'message' && e.role === 'user')
  return {
    ...response,
    result: { ...response.result, entries: entries.slice(lastUser + 1), settled }
  }
}

export function formatSettled(result: ChatTranscript & { settled: ChatSettled }): string {
  const status =
    result.settled === 'timeout'
      ? 'Still working when the wait timed out.'
      : result.settled === 'held'
        ? 'Your message is held in the queue (the chat was stopped or the send failed). Resume it in Orca.'
        : result.settled === 'waiting'
          ? 'Waiting for you to answer.'
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
