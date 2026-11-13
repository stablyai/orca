import { randomUUID } from 'node:crypto'
import type { CommandHandler } from '../dispatch/dispatch'
import { getPresentStringFlag, getRequiredStringFlag } from '../arguments/flags'
import { readTextOrFileFlag } from '../arguments/command-body-input'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/types'
import { readInjectedAgentSessionId } from '../../shared/agent-session/lifecycle/agent-session-caller-env'
import { createStructuredAgentSessionOperationId } from '../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import {
  structuredAgentSessionMessageSendMutation,
  structuredAgentSessionSendBody
} from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY } from '../../shared/agent-session/agent-session-runtime-capabilities'
import type {
  AgentSessionHistoryResult,
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../shared/agent-session/agent-session-wire'

type ChatRenameResult = { name: string | null; applied: boolean }

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
        throw explainChatRefusal(error, sessionId, 'rename chats')
      })
    if (!result.result.applied) {
      throw new RuntimeClientError('invalid_argument', 'Not renamed: the name has no visible text.')
    }
    printResult(result, json, (value) => `Renamed chat to "${value.name}".`)
  },
  'chat send': async ({ flags, client, cwd, json }) => {
    const sessionId = getRequiredStringFlag(flags, 'session')
    const text = (await readTextOrFileFlag(flags, cwd, 'text', true)) ?? ''
    if (text.trim().length === 0) {
      throw new RuntimeClientError('invalid_argument', 'The message must not be empty.')
    }
    const status = await client.getCliStatus()
    // A chat in the middle of a turn queues the message until the turn ends, as the app does.
    const queue =
      status.result.runtime.capabilities?.includes(
        AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY
      ) === true
    // The send is fenced to the chat's current runtime, read just before it.
    const history = await client
      .call<AgentSessionHistoryResult>('agentSession.history', {
        sessionId,
        direction: 'tail',
        limit: 1
      })
      .catch((error: unknown) => {
        throw explainChatRefusal(error, sessionId, 'send to chats')
      })
    const fence = history.result.ok ? history.result.page.fence : history.result.fence
    if (fence === undefined) {
      throw new RuntimeClientError(
        'agent_session_not_running',
        `Chat ${sessionId} has no session on this host, so nothing was sent.`
      )
    }
    const result = await client
      .call<AgentSessionMutationResult<AgentSessionSendResult>>(
        'agentSession.send',
        structuredAgentSessionMessageSendMutation({
          sessionId,
          clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
          expectedRuntimeFence: fence,
          body: structuredAgentSessionSendBody(text, []),
          ...(queue ? { delivery: 'queue-if-active' as const } : {})
        })
      )
      .catch((error: unknown) => {
        throw explainChatRefusal(error, sessionId, 'send to chats')
      })
    if (!result.result.ok) {
      throw new RuntimeClientError(result.result.refusal.code, result.result.refusal.message)
    }
    const value = result.result.value
    const sent = {
      sessionId,
      delivery: 'queued' in value ? ('queued' as const) : ('sent' as const),
      clientMessageId: value.clientMessageId
    }
    printResult({ ...result, result: sent }, json, (r) =>
      r.delivery === 'queued'
        ? `Queued for chat ${r.sessionId}; it is sent when the current turn ends.`
        : `Sent to chat ${r.sessionId}.`
    )
  },
  'chat close': async ({ flags, client, json }) => {
    const sessionId = getRequiredStringFlag(flags, 'session')
    const result = await client
      .call<{ ok: true }>('agentSession.close', { sessionId })
      .catch((error: unknown) => {
        throw explainChatRefusal(error, sessionId, 'close chats')
      })
    printResult(
      { ...result, result: { sessionId, closed: true } },
      json,
      (r) => `Closed chat ${r.sessionId}.`
    )
  }
}

// The host answers with bare wire codes; say what they mean for this command.
function explainChatRefusal(error: unknown, sessionId: string, action: string): unknown {
  if (!(error instanceof RuntimeClientError)) {
    return error
  }
  if (error.message === 'agent_session_identity_required') {
    return new RuntimeClientError(
      'agent_session_identity_required',
      `No chat with session id ${sessionId} on this host.`
    )
  }
  if (
    error.message === 'structured_agent_session_unsupported' ||
    error.code === 'method_not_found'
  ) {
    return new RuntimeClientError(
      'incompatible_runtime',
      `This Orca host cannot ${action} from the CLI. Update Orca on that host, or check that it has chats turned on.`
    )
  }
  return error
}
