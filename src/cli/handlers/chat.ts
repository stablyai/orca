import { randomUUID } from 'node:crypto'
import type {
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../shared/agent-session/agent-session-wire'
import { AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY } from '../../shared/agent-session/agent-session-runtime-capabilities'
import type {
  RuntimeWorktreePsResult,
  RuntimeWorktreeRecord
} from '../../shared/runtime-worktree-contracts'
import { createStructuredAgentSessionOperationId } from '../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import {
  structuredAgentSessionMessageSendMutation,
  structuredAgentSessionSendBody
} from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { AGENT_STATUS_STATES } from '../../shared/agent-status/contracts/agent-status-types'
import { readInjectedAgentSessionId } from '../../shared/agent-session/lifecycle/agent-session-caller-env'
import {
  DEFAULT_READ_LIMIT,
  explainChatRefusal,
  formatSettled,
  readHistory,
  readSettledTurn,
  readTranscript,
  requireWorkingFlag,
  waitForChat
} from '../chat-history'
import {
  formatChatList,
  formatChatRead,
  listChatSessions,
  parseChatSessionSelector
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
import { getOptionalWorktreeSelector } from '../selectors'
import type { RuntimeClient } from '../runtime-client'
import { RuntimeClientError } from '../runtime-client'

const MAX_READ_LIMIT = 100

type ChatRenameResult = { name: string | null; applied: boolean }

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
  'chat list': async ({ flags, client, cwd, json }) => {
    const state = getOptionalStringFlag(flags, 'state')
    if (state !== undefined && !AGENT_STATUS_STATES.some((known) => known === state)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--state must be one of: ${AGENT_STATUS_STATES.join(', ')}.`
      )
    }
    const selector = await getOptionalWorktreeSelector(flags, 'worktree', cwd, client)
    const shown = selector
      ? (
          await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
            worktree: selector
          })
        ).result.worktree
      : undefined
    const result = await client.call<RuntimeWorktreePsResult>('worktree.ps', {})
    // A local and an SSH copy can share an id; the host tells them apart when both name one.
    const worktrees = result.result.worktrees.filter(
      (w) =>
        !shown ||
        (w.worktreeId === shown.id &&
          (w.hostId === undefined || shown.hostId === undefined || w.hostId === shown.hostId))
    )
    const chats = listChatSessions(worktrees).filter((chat) => !state || chat.state === state)
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
    const { page } = (await readHistory(client, session, 1)).result
    if (wait) {
      requireWorkingFlag(page)
    }
    const { fence } = page
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
