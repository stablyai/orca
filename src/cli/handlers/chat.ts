import type { CommandHandler } from '../dispatch'
import { getPresentStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { readInjectedAgentSessionId } from '../../shared/agent-session/lifecycle/agent-session-caller-env'

type ChatRenameResult = { name: string | null; applied: boolean }
// Hosts before `found` answer `{ ok: true }` alone.
type ChatCloseResult = { ok: true; found?: boolean }

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
  'chat close': async ({ flags, client, json }) => {
    // No default to the injected id: a chat closing itself would stop the agent running this command.
    const sessionId = getRequiredStringFlag(flags, 'session')
    const result = await client
      .call<ChatCloseResult>('agentSession.close', { sessionId })
      .catch((error: unknown) => {
        throw explainChatRefusal(error, sessionId, 'close')
      })
    if (result.result.found === false) {
      throw new RuntimeClientError(
        'agent_session_identity_required',
        `No chat with session id ${sessionId} on this host.`
      )
    }
    printResult(result, json, () => `Closed chat ${sessionId}.`)
  }
}

// The host answers with bare wire codes; say what they mean for this command.
function explainChatRefusal(error: unknown, sessionId: string, verb: 'rename' | 'close'): unknown {
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
      `This Orca host cannot ${verb} chats from the CLI. Update Orca on that host, or check that it has chats turned on.`
    )
  }
  return error
}
