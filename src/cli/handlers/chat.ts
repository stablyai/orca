import { randomUUID } from 'node:crypto'
import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryResult,
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../shared/agent-session/agent-session-wire'
import { AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY } from '../../shared/agent-session/agent-session-runtime-capabilities'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../shared/agent-session/agent-session-wire'
import {
  AGENT_SESSION_UNATTACHED_REFUSAL_CODE,
  isUnattachedAgentSessionReadRefusal
} from '../../shared/agent-session/failures/structured-agent-session-read-refusal'
import type { RuntimeWorktreePsResult } from '../../shared/runtime-worktree-contracts'
import { createStructuredAgentSessionOperationId } from '../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import {
  structuredAgentSessionMessageSendMutation,
  structuredAgentSessionSendBody
} from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import {
  chatTranscript,
  formatChatList,
  formatChatRead,
  listChatSessions,
  parseChatSessionSelector,
  type ChatTranscriptEntry
} from '../chat-sessions'
import { readTextOrFileFlag } from '../command-body-input'
import type { CommandHandler } from '../dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getPresentStringFlag,
  getRequiredStringFlag
} from '../flags'
import { printResult } from '../format'
import type { RuntimeClient, RuntimeRpcSuccess } from '../runtime-client'
import { RuntimeClientError } from '../runtime-client'
import { readInjectedAgentSessionId } from '../../shared/agent-session/lifecycle/agent-session-caller-env'

const DEFAULT_READ_LIMIT = 20
const MAX_READ_LIMIT = 100
// Status frames and turn markers share the journal with the conversation, so fetch more rows than shown.
const HISTORY_ROWS_PER_ENTRY = 4
const WAIT_POLL_MS = 1000

type ChatRenameResult = { name: string | null; applied: boolean }
type ChatTranscript = {
  session: string
  entries: ChatTranscriptEntry[]
  /** Newest journal row read, so a later `--since` can continue from it. */
  cursor: AgentSessionHistoryPage['window']['newest']
}
type ChatSettled = 'idle' | 'waiting' | 'timeout'

// Paired CLIs lack the host's chat read/send capability; refuse before the host does with a bare code.
function readSession(flags: Map<string, string | boolean>, client: RuntimeClient): string {
  if (client.isRemote) {
    throw new RuntimeClientError(
      'runtime_unsupported',
      'Reading and messaging chats on a paired host is not supported yet. Run this on the host machine.'
    )
  }
  return parseChatSessionSelector(getRequiredStringFlag(flags, 'session'))
}

async function readHistory(
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

async function readTranscript(
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

// Settled means no running turn or unanswered send, or a question/approval waiting for the user.
async function waitForChat(
  client: RuntimeClient,
  session: string,
  timeoutMs: number | undefined,
  queuedMessageId?: string
): Promise<ChatSettled> {
  const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs
  for (;;) {
    const { page } = (await readHistory(client, session, 1)).result
    if (page.working === undefined) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca host does not report when a chat is working, so it cannot wait. Update Orca on the host.'
      )
    }
    if ((page.actionablePromptIds?.length ?? 0) > 0) {
      return 'waiting'
    }
    const stillQueued = page.queuedMessages?.some((m) => m.messageId === queuedMessageId) === true
    if (!page.working && !stillQueued) {
      return 'idle'
    }
    if (Date.now() >= deadline) {
      return 'timeout'
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS))
  }
}

// After a wait, the turn's entries: everything after the last user message.
async function readSettledTurn(
  client: RuntimeClient,
  session: string,
  settled: ChatSettled
): Promise<RuntimeRpcSuccess<ChatTranscript & { settled: ChatSettled }>> {
  if (settled === 'timeout') {
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

function formatSettled(result: ChatTranscript & { settled: ChatSettled }): string {
  const status =
    result.settled === 'timeout'
      ? 'Still working when the wait timed out.'
      : result.settled === 'waiting'
        ? 'Waiting for you to answer.'
        : 'Done.'
  return result.entries.length === 0 ? status : `${formatChatRead(result)}\n${status}`
}

export const CHAT_HANDLERS: Record<string, CommandHandler> = {
  'chat rename': async ({ flags, client, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    // An empty --session must not fall back to this chat; the injected id is local-only.
    const sessionId =
      getPresentStringFlag(flags, 'session') ??
      (client.isRemote ? undefined : readInjectedAgentSessionId())
    if (!sessionId) {
      throw new RuntimeClientError(
        'invalid_argument',
        client.isRemote
          ? 'Missing required --session: on a paired host, name the chat by its session id.'
          : 'Missing required --session: this is not running inside a chat, so name the chat by its session id.'
      )
    }
    const result = await client
      .call<ChatRenameResult>('agentSession.rename', { sessionId, name })
      .catch((error: unknown) => {
        throw explainChatRefusal(error, sessionId, 'rename')
      })
    if (!result.result.applied) {
      throw new RuntimeClientError('invalid_argument', 'Not renamed: the name has no visible text.')
    }
    printResult(result, json, (value) => `Renamed chat to "${value.name}".`)
  },
  'chat list': async ({ flags, client, json }) => {
    const result = await client.call<RuntimeWorktreePsResult>('worktree.ps', {})
    const worktree = getOptionalStringFlag(flags, 'worktree')
    const state = getOptionalStringFlag(flags, 'state')
    const chats = listChatSessions(result.result.worktrees).filter(
      (chat) =>
        (worktree === undefined || chat.worktree === worktree || chat.worktreeId === worktree) &&
        (!state || chat.state === state)
    )
    printResult({ ...result, result: { chats } }, json, formatChatList)
  },
  'chat read': async ({ flags, client, json }) => {
    const session = readSession(flags, client)
    const limit = getOptionalPositiveIntegerFlag(flags, 'limit') ?? DEFAULT_READ_LIMIT
    if (limit > MAX_READ_LIMIT) {
      throw new RuntimeClientError('invalid_argument', `--limit must be at most ${MAX_READ_LIMIT}.`)
    }
    printResult(await readTranscript(client, session, limit), json, formatChatRead)
  },
  'chat wait': async ({ flags, client, json }) => {
    const session = readSession(flags, client)
    const timeoutMs = getOptionalPositiveIntegerFlag(flags, 'timeout-ms')
    const settled = await waitForChat(client, session, timeoutMs)
    printResult(await readSettledTurn(client, session, settled), json, formatSettled)
  },
  'chat send': async ({ flags, client, cwd, json }) => {
    const session = readSession(flags, client)
    const text = (await readTextOrFileFlag(flags, cwd, 'text', true)) ?? ''
    if (text.trim().length === 0) {
      throw new RuntimeClientError('invalid_argument', 'The message must not be empty.')
    }
    const wait = flags.has('wait')
    const timeoutMs = getOptionalPositiveIntegerFlag(flags, 'timeout-ms')
    const status = await client.getCliStatus()
    if (!status.result.runtime.reachable) {
      throw new RuntimeClientError(
        'runtime_unavailable',
        'Orca could not reach the execution host, so nothing was sent. Retry once it is reachable.'
      )
    }
    // A working chat holds a queued message until its turn ends; older hosts get an ordinary send.
    const queue =
      status.result.runtime.capabilities?.includes(
        AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY
      ) === true
    // The send is fenced to the session's current runtime, so a restarted chat refuses it.
    const { fence } = (await readHistory(client, session, 1)).result.page
    if (fence === undefined) {
      throw new RuntimeClientError(
        'agent_session_not_running',
        `Chat ${session} has no running session on this host, so nothing was sent. Open it in Orca and retry.`
      )
    }
    const mutation = structuredAgentSessionMessageSendMutation({
      sessionId: session,
      clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
      expectedRuntimeFence: fence,
      body: structuredAgentSessionSendBody(text, []),
      ...(queue ? { delivery: 'queue-if-active' as const } : {})
    })
    const result = await client.call<AgentSessionMutationResult<AgentSessionSendResult>>(
      'agentSession.send',
      mutation
    )
    if (!result.result.ok) {
      const { code, message } = result.result.refusal
      throw explainChatRefusal(new RuntimeClientError(code, message), session, 'send to')
    }
    const value = result.result.value
    const sent = {
      session,
      delivery: 'queued' in value ? ('queued' as const) : ('submitted' as const),
      clientMessageId: value.clientMessageId,
      ...('queued' in value ? { queuePosition: value.queued.position } : {})
    }
    if (!wait) {
      printResult({ ...result, result: sent }, json, (r) =>
        r.delivery === 'queued'
          ? `Queued for ${r.session}; it is sent when the current turn ends.`
          : `Sent to ${r.session}.`
      )
      return
    }
    const queuedId = 'queued' in value ? value.queued.messageId : undefined
    const settled = await waitForChat(client, session, timeoutMs, queuedId)
    const turn = await readSettledTurn(client, session, settled)
    printResult({ ...turn, result: { ...sent, ...turn.result } }, json, formatSettled)
  }
}

// The host answers with bare wire codes; say what they mean for this command.
function explainChatRefusal(
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
