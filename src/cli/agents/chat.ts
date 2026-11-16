import type { CommandHandler } from '../dispatch/dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getPresentStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { readInjectedAgentSessionId } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { structuredSessionIdFromNotificationPane } from '../../shared/agent-session/view/structured-session-notification-pane'
import {
  AGENT_SESSION_HISTORY_DIRECTIONS,
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionHistoryDirection,
  type AgentSessionHistoryResult
} from '../../shared/agent-session/agent-session-wire'
import type { RuntimeWorktreePsResult } from '../../shared/worktree/catalog/runtime-worktree-contracts'
import { journalItemCliLines } from './chat-transcript-lines'

type ChatRenameResult = { name: string | null; applied: boolean }

type ChatListEntry = {
  sessionId: string
  paneKey: string
  parentPaneKey: string | null
  agentType: string | null
  state: string
  conversationName: string | null
  lastAssistantMessage: string | null
  worktree: {
    worktreeId: string
    displayName: string | null
    path: string
  }
}

function resolveSessionId(flag: string | undefined, isRemote: boolean): string {
  const given = flag ?? (isRemote ? undefined : readInjectedAgentSessionId())
  if (!given) {
    throw new RuntimeClientError(
      'invalid_argument',
      isRemote
        ? 'Missing required --session: on a paired host, name the chat by its session id.'
        : 'Missing required --session: this is not running inside a chat, so name the chat by its session id.'
    )
  }
  // A paneKey from `chat list` or `worktree ps` resolves to its session id too.
  const fromPane = structuredSessionIdFromNotificationPane(given)
  return fromPane ?? given
}

export const CHAT_HANDLERS: Record<string, CommandHandler> = {
  'chat list': async ({ flags, client, json }) => {
    const result = await client.call<RuntimeWorktreePsResult>('worktree.ps', {
      limit: getOptionalPositiveIntegerFlag(flags, 'limit')
    })
    const chats: ChatListEntry[] = result.result.worktrees.flatMap((worktree) =>
      worktree.agents.flatMap((agent) => {
        const sessionId = structuredSessionIdFromNotificationPane(agent.paneKey)
        if (!sessionId) {
          return []
        }
        return [
          {
            sessionId,
            paneKey: agent.paneKey,
            parentPaneKey: agent.parentPaneKey,
            agentType: agent.agentType,
            state: agent.state,
            conversationName: agent.conversationName ?? agent.displayName,
            lastAssistantMessage: agent.lastAssistantMessage,
            worktree: {
              worktreeId: worktree.worktreeId,
              displayName: worktree.displayName ?? null,
              path: worktree.path
            }
          }
        ]
      })
    )
    printResult({ ...result, result: { chats } }, json, (value) =>
      value.chats.length === 0
        ? 'No chat sessions.'
        : value.chats
            .map(
              (chat) =>
                `${chat.sessionId}  ${chat.agentType ?? 'agent'}  ${chat.state}  ${chat.conversationName ?? ''}  ${chat.worktree.path}`
            )
            .join('\n')
    )
  },
  'chat read': async ({ flags, client, json }) => {
    const sessionId = resolveSessionId(getPresentStringFlag(flags, 'session'), client.isRemote)
    const directionArg = getOptionalStringFlag(flags, 'direction') ?? 'tail'
    if (!AGENT_SESSION_HISTORY_DIRECTIONS.includes(directionArg as AgentSessionHistoryDirection)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--direction must be one of ${AGENT_SESSION_HISTORY_DIRECTIONS.join(', ')}.`
      )
    }
    const direction = directionArg as AgentSessionHistoryDirection
    const cursorArg = getOptionalStringFlag(flags, 'cursor')
    if (direction !== 'tail' && !cursorArg) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--direction ${direction} needs --cursor, from a previous read's window.nextCursor.`
      )
    }
    let cursor: unknown
    if (cursorArg) {
      try {
        cursor = JSON.parse(cursorArg)
      } catch {
        throw new RuntimeClientError(
          'invalid_argument',
          '--cursor must be a JSON cursor object, as printed by a previous read (e.g. {"epoch":"...","sequence":123}).'
        )
      }
    }
    const result = await client
      .call<AgentSessionHistoryResult>('agentSession.history', {
        sessionId,
        direction,
        ...(cursor !== undefined ? { cursor } : {}),
        limit: Math.min(
          getOptionalPositiveIntegerFlag(flags, 'limit') ?? 40,
          AGENT_SESSION_HISTORY_MAX_LIMIT
        )
      })
      .catch((error: unknown) => {
        throw explainReadRefusal(error, sessionId)
      })
    const { page } = result.result
    const reset = result.result.ok ? undefined : result.result.reset
    const lines = page.items.flatMap(journalItemCliLines)
    const projected = {
      sessionId: page.sessionId,
      lines,
      reset,
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
      window: page.window,
      liveCursor: page.liveCursor,
      latestTurn: page.latestTurn
    }
    printResult({ ...result, result: projected }, json, (value) => {
      const header = value.reset ? `cursor reset: ${value.reset}; showing the bounded tail.\n` : ''
      const footer = `\n---\nhasOlder=${value.hasOlder} hasNewer=${value.hasNewer} nextCursor=${value.window.nextCursor}`
      return header + (value.lines.length > 0 ? value.lines.join('\n') : '(no rows)') + footer
    })
  },
  'chat rename': async ({ flags, client, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    // An empty --session must not fall back to this chat; the injected id is local-only.
    const sessionId = resolveSessionId(getPresentStringFlag(flags, 'session'), client.isRemote)
    const result = await client
      .call<ChatRenameResult>('agentSession.rename', { sessionId, name })
      .catch((error: unknown) => {
        throw explainRenameRefusal(error, sessionId)
      })
    if (!result.result.applied) {
      throw new RuntimeClientError('invalid_argument', 'Not renamed: the name has no visible text.')
    }
    printResult(result, json, (value) => `Renamed chat to "${value.name}".`)
  }
}

// The host answers with bare wire codes; say what they mean for this command.
function explainRenameRefusal(error: unknown, sessionId: string): unknown {
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
      'This Orca host cannot rename chats from the CLI. Update Orca on that host, or check that it has chats turned on.'
    )
  }
  return error
}

function explainReadRefusal(error: unknown, sessionId: string): unknown {
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
      'This Orca host cannot read chats from the CLI. Update Orca on that host, or check that it has chats turned on.'
    )
  }
  return error
}
