import { randomUUID } from 'node:crypto'
import type {
  AgentSessionHistoryPage,
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../shared/agent-session-wire'
import { AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY } from '../../shared/agent-session-runtime-capabilities'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../shared/agent-session-wire'
import type { RuntimeWorktreePsResult } from '../../shared/runtime-worktree-contracts'
import { createStructuredAgentSessionOperationId } from '../../shared/structured-agent-session-mutation'
import {
  structuredAgentSessionMessageSendMutation,
  structuredAgentSessionSendBody
} from '../../shared/structured-agent-session-send-mutation'
import {
  chatTranscript,
  formatChatList,
  formatChatRead,
  listChatSessions,
  parseChatSessionSelector
} from '../chat-sessions'
import type { CommandHandler } from '../dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'

const DEFAULT_READ_LIMIT = 20
const MAX_READ_LIMIT = 100
// Why: provider status frames and turn markers share the journal with the conversation, so the
// read fetches more rows than it shows to return the requested number of readable entries.
const HISTORY_ROWS_PER_ENTRY = 4
const MAX_HISTORY_ROWS = AGENT_SESSION_HISTORY_MAX_LIMIT

type HistoryResult = { ok: boolean; page: AgentSessionHistoryPage }

function readSession(flags: Map<string, string | boolean>): string {
  return parseChatSessionSelector(getRequiredStringFlag(flags, 'session'))
}

export const CHAT_HANDLERS: Record<string, CommandHandler> = {
  'chat list': async ({ flags, client, json }) => {
    const result = await client.call<RuntimeWorktreePsResult>('worktree.ps', {})
    const worktree = getOptionalStringFlag(flags, 'worktree')
    const chats = listChatSessions(result.result.worktrees).filter(
      (chat) => worktree === undefined || chat.worktree === worktree || chat.worktreeId === worktree
    )
    const state = getOptionalStringFlag(flags, 'state')
    printResult(
      { ...result, result: { chats: chats.filter((chat) => !state || chat.state === state) } },
      json,
      formatChatList
    )
  },
  'chat read': async ({ flags, client, json }) => {
    const session = readSession(flags)
    const limit = getOptionalPositiveIntegerFlag(flags, 'limit') ?? DEFAULT_READ_LIMIT
    if (limit > MAX_READ_LIMIT) {
      throw new RuntimeClientError('invalid_argument', `--limit must be at most ${MAX_READ_LIMIT}.`)
    }
    const result = await client.call<HistoryResult>('agentSession.history', {
      sessionId: session,
      direction: 'tail',
      limit: Math.min(limit * HISTORY_ROWS_PER_ENTRY, MAX_HISTORY_ROWS)
    })
    // Why: status frames and turn markers can outweigh the readable rows on a page, so
    // page backward until the requested entry count is met or the journal is exhausted.
    let page = result.result.page
    let entries = chatTranscript(page.items)
    while (entries.length < limit && page.hasOlder && page.window.oldest) {
      const cursor = page.window.oldest
      const older = await client.call<HistoryResult>('agentSession.history', {
        sessionId: session,
        direction: 'before',
        cursor,
        limit: MAX_HISTORY_ROWS
      })
      // Why: a stale or ahead cursor returns a reset carrying a fresh tail page; that
      // page replaces the window instead of extending it, then paging resumes from it.
      if (!older.result.ok) {
        page = older.result.page
        entries = chatTranscript(page.items)
        continue
      }
      const olderPage = older.result.page
      // An empty page reports the request cursor back; stop rather than loop on it.
      if (
        olderPage.window.oldest?.epoch === cursor.epoch &&
        olderPage.window.oldest?.sequence === cursor.sequence
      ) {
        break
      }
      entries = [...chatTranscript(olderPage.items), ...entries]
      page = olderPage
    }
    printResult(
      {
        ...result,
        result: { session, entries: entries.slice(-limit) }
      },
      json,
      formatChatRead
    )
  },
  'chat send': async ({ flags, client, json }) => {
    const session = readSession(flags)
    const text = getRequiredStringFlag(flags, 'text')
    if (text.trim().length === 0) {
      throw new RuntimeClientError('invalid_argument', '--text must not be empty.')
    }
    const status = await client.getCliStatus()
    if (!status.result.runtime.reachable) {
      throw new RuntimeClientError(
        'runtime_unavailable',
        'Orca could not reach the execution host, so nothing was sent. Retry once it is reachable.'
      )
    }
    // Why: a chat that is mid-turn holds a queued message until the turn ends instead of
    // steering it; an older host without the queue receives an ordinary send.
    const queue =
      status.result.runtime.capabilities?.includes(
        AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY
      ) === true
    // The send is fenced to the session's current runtime, so a restarted chat refuses it.
    const history = await client.call<HistoryResult>('agentSession.history', {
      sessionId: session,
      direction: 'tail',
      limit: 1
    })
    const fence = history.result.page.fence
    if (fence === undefined) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca host does not report the chat fence needed to send. Update Orca on the execution host.'
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
      throw new RuntimeClientError(result.result.refusal.code, result.result.refusal.message)
    }
    const value = result.result.value
    const delivery = 'queued' in value ? 'queued' : 'submitted'
    printResult(
      {
        ...result,
        result: {
          session,
          delivery,
          clientMessageId: value.clientMessageId,
          ...('queued' in value ? { queuePosition: value.queued.position } : {})
        }
      },
      json,
      (sent) =>
        sent.delivery === 'queued'
          ? `Queued for ${sent.session}; it is sent when the current turn ends.`
          : `Sent to ${sent.session}.`
    )
  }
}
