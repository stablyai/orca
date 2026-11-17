import type { CommandHandler } from '../dispatch/dispatch'
import { getPresentStringFlag, getRequiredStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { readInjectedAgentSessionId } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import type { AgentSessionProviderRemoteControlResult } from '../../shared/agent-session/remote-control/agent-session-provider-remote-control'

type ChatRenameResult = { name: string | null; applied: boolean }

const REMOTE_CONTROL_ACTIONS = ['on', 'off', 'status'] as const

export const CHAT_HANDLERS: Record<string, CommandHandler> = {
  'chat remote-control': async ({ flags, client, json }) => {
    const action = getPresentStringFlag(flags, 'action') ?? 'status'
    if (!REMOTE_CONTROL_ACTIONS.some((known) => known === action)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unknown action "${action}": use on, off or status.`
      )
    }
    const sessionId = chatSessionIdFlag(flags, client.isRemote)
    const result = await client
      .call<AgentSessionProviderRemoteControlResult>('agentSession.providerRemoteControl', {
        sessionId,
        ...(action === 'status' ? {} : { choice: action })
      })
      .catch((error: unknown) => {
        throw explainChatRefusal(error, sessionId, 'change Remote Control')
      })
    if (result.result.status !== 'ok') {
      throw new RuntimeClientError(
        'invalid_argument',
        "Not changed: this chat's agent has no Remote Control. It is a Claude Code feature."
      )
    }
    printResult(result, json, remoteControlText)
  },
  'chat rename': async ({ flags, client, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    const sessionId = chatSessionIdFlag(flags, client.isRemote)
    const result = await client
      .call<ChatRenameResult>('agentSession.rename', { sessionId, name })
      .catch((error: unknown) => {
        throw explainChatRefusal(error, sessionId, 'rename chats')
      })
    if (!result.result.applied) {
      throw new RuntimeClientError('invalid_argument', 'Not renamed: the name has no visible text.')
    }
    printResult(result, json, (value) => `Renamed chat to "${value.name}".`)
  }
}

function remoteControlText(result: AgentSessionProviderRemoteControlResult): string {
  if (result.status !== 'ok') {
    return "This chat's agent has no Remote Control."
  }
  const link = result.link
  const state = !link
    ? 'off'
    : link.state === 'policy-disabled'
      ? 'turned off by your organization'
      : link.state
  return [
    `Remote Control: ${state}${link?.detail ? ` (${link.detail})` : ''}`,
    ...(link?.sessionUrl ? [`Link: ${link.sessionUrl}`] : []),
    `Saved choice: ${result.choice ?? 'follows the Remote Control setting'}`,
    ...(result.choice && !result.live && !link ? ['Applies when the chat next starts.'] : [])
  ].join('\n')
}

// The host answers with bare wire codes; say what they mean for this command.
function explainChatRefusal(error: unknown, sessionId: string, verb: string): unknown {
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
      `This Orca host cannot ${verb} from the CLI. Update Orca on that host, or check that it has chats turned on.`
    )
  }
  return error
}

/** An empty --session must not fall back to this chat; the injected id is local-only. */
function chatSessionIdFlag(flags: Parameters<CommandHandler>[0]['flags'], remote: boolean): string {
  const sessionId =
    getPresentStringFlag(flags, 'session') ?? (remote ? undefined : readInjectedAgentSessionId())
  if (!sessionId) {
    throw new RuntimeClientError(
      'invalid_argument',
      remote
        ? 'Missing required --session: on a paired host, name the chat by its session id.'
        : 'Missing required --session: this is not running inside a chat, so name the chat by its session id.'
    )
  }
  return sessionId
}
