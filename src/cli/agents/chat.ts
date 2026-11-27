import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { CommandHandler } from '../dispatch/dispatch'
import { getPresentStringFlag, getRequiredStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { readInjectedAgentSessionId } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import {
  AGENT_SESSION_BADGE_ICON_MAX_LENGTH,
  readAgentSessionBadge,
  type AgentSessionBadge
} from '../../shared/agent-session/conversation-naming/agent-session-badge'

type ChatRenameResult = { name: string | null; applied: boolean }
type ChatBadgeResult = { badge: AgentSessionBadge | null }

const BADGE_ICON_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
}

export const CHAT_HANDLERS: Record<string, CommandHandler> = {
  'chat rename': async ({ flags, client, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    const sessionId = chatSessionId(flags, client.isRemote)
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
  'chat badge': async ({ flags, client, json }) => {
    const clear = flags.get('clear') === true
    if (clear && (flags.has('icon') || flags.has('label'))) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Pass either --clear or --icon with --label.'
      )
    }
    const badge = clear
      ? null
      : await readBadgeFlags(
          getRequiredStringFlag(flags, 'icon'),
          getRequiredStringFlag(flags, 'label')
        )
    const sessionId = chatSessionId(flags, client.isRemote)
    const result = await client
      .call<ChatBadgeResult>('agentSession.setBadge', { sessionId, badge })
      .catch((error: unknown) => {
        throw explainChatRefusal(error, sessionId, 'badge')
      })
    printResult(result, json, (value) =>
      value.badge ? `Badged chat "${value.badge.label}".` : "Cleared the chat's badge."
    )
  }
}

function chatSessionId(flags: Map<string, string | boolean>, isRemote: boolean): string {
  // An empty --session must not fall back to this chat; the injected id is local-only.
  const sessionId =
    getPresentStringFlag(flags, 'session') ?? (isRemote ? undefined : readInjectedAgentSessionId())
  if (!sessionId) {
    throw new RuntimeClientError(
      'invalid_argument',
      isRemote
        ? 'Missing required --session: on a paired host, name the chat by its session id.'
        : 'Missing required --session: this is not running inside a chat, so name the chat by its session id.'
    )
  }
  return sessionId
}

/** The picture is read here, where the file is, and sent inline: a paired host cannot read it. */
async function readBadgeFlags(iconPath: string, label: string): Promise<AgentSessionBadge> {
  const type = BADGE_ICON_TYPES[extname(iconPath).toLowerCase()]
  if (!type) {
    throw new RuntimeClientError('invalid_argument', '--icon must be a .png, .webp or .svg file.')
  }
  const bytes = await readFile(iconPath).catch((error: unknown) => {
    throw new RuntimeClientError(
      'invalid_argument',
      `Could not read --icon ${iconPath}: ${error instanceof Error ? error.message : String(error)}`
    )
  })
  const icon = `data:${type};base64,${bytes.toString('base64')}`
  if (icon.length > AGENT_SESSION_BADGE_ICON_MAX_LENGTH) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--icon is ${bytes.length} bytes; a badge picture must be about 6 KB or less.`
    )
  }
  const badge = readAgentSessionBadge({ label, icon })
  if (!badge) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--label must have visible text, at most 64 characters.'
    )
  }
  return badge
}

// The host answers with bare wire codes; say what they mean for this command.
function explainChatRefusal(error: unknown, sessionId: string, verb: 'rename' | 'badge'): unknown {
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
