import { agentSessionPromptQuestions } from '../shared/agent-session/agent-session-question-answer'
import { isActionableStructuredAgentSessionPrompt } from '../shared/agent-session/view/structured-agent-session-live-turn'
import { isRootAgentJournalItem } from '../shared/agent-session/journal/agent-session-journal-producer'
import type { AgentJournalRenderItem } from '../shared/agent-session/journal/agent-session-journal-types'
import type {
  RuntimeWorktreeAgentRow,
  RuntimeWorktreePsSummary
} from '../shared/runtime-worktree-contracts'
import { structuredAgentSessionTabId } from '../shared/agent-session/view/structured-agent-session-projection'
import { RuntimeClientError } from './runtime-client'

const CHAT_HANDLE_PREFIX = structuredAgentSessionTabId('')

export type ChatSessionEntry = {
  session: string
  handle: string
  worktreeId: string
  worktree: string
  agentType: string | null
  state: RuntimeWorktreeAgentRow['state']
  title: string | null
  lastAssistantMessage: string | null
  updatedAt: number
}

export type ChatTranscriptEntry =
  | { kind: 'message'; role: string; text: string }
  | { kind: 'tool'; name: string; state: string }
  | { kind: 'approval' | 'question'; text: string; pending: boolean }
  | { kind: 'error'; text: string }

/** The session id a chat is addressed by, from its id, its handle, or a pane key that names it. */
export function parseChatSessionSelector(value: string): string {
  const withoutHandle = value.startsWith(CHAT_HANDLE_PREFIX)
    ? value.slice(CHAT_HANDLE_PREFIX.length)
    : value
  // A pane key is the chat's handle and its leaf: "<handle>:<leaf>".
  const session = withoutHandle.split(':')[0]?.trim() ?? ''
  if (session.length === 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--session needs a chat session id or handle; run `orca chat list` to find one.'
    )
  }
  return session
}

/** The top-level chats in a worktree summary. Terminal agents and subagents are left out:
 *  terminals are read with `orca terminal`, and a subagent is reached through its parent chat. */
export function listChatSessions(
  worktrees: readonly RuntimeWorktreePsSummary[]
): ChatSessionEntry[] {
  return worktrees.flatMap((worktree) =>
    worktree.agents
      .filter(
        (agent) => agent.parentPaneKey === null && agent.paneKey.startsWith(CHAT_HANDLE_PREFIX)
      )
      .map((agent) => {
        const session = parseChatSessionSelector(agent.paneKey)
        return {
          session,
          handle: structuredAgentSessionTabId(session),
          worktreeId: worktree.worktreeId,
          worktree: worktree.displayName,
          agentType: agent.agentType,
          state: agent.state,
          title: agent.displayName ?? agent.taskTitle,
          lastAssistantMessage: agent.lastAssistantMessage,
          updatedAt: agent.updatedAt
        }
      })
  )
}

function messageText(item: AgentJournalRenderItem): string {
  if (item.body.kind !== 'message') {
    return ''
  }
  return item.body.blocks
    .map((block) =>
      block.type === 'text' ? block.text : block.type === 'image-ref' ? '[image]' : ''
    )
    .filter((text) => text.length > 0)
    .join('\n')
    .trim()
}

/** The conversation as a reader follows it: messages, the tools the agent ran, and the
 *  approvals and questions it raised. Provider status frames and turn markers are left out. */
export function chatTranscript(
  items: readonly AgentJournalRenderItem[],
  actionablePromptIds?: readonly string[]
): ChatTranscriptEntry[] {
  // An ended agent's unanswered prompts stay pending in the journal but can no longer be answered.
  const waiting = (item: AgentJournalRenderItem, state: string): boolean =>
    state === 'pending' &&
    isActionableStructuredAgentSessionPrompt(item.itemId, actionablePromptIds)
  const entries: ChatTranscriptEntry[] = []
  for (const item of items) {
    // Subagents share the journal; their rows belong to their own section, not the chat's turn.
    if (!isRootAgentJournalItem(item)) {
      continue
    }
    const body = item.body
    if (body.kind === 'message') {
      const text = messageText(item)
      // Reasoning is the model's scratch work, folded away in the app too.
      if (text.length > 0 && body.role !== 'reasoning') {
        entries.push({ kind: 'message', role: body.role, text })
      }
    } else if (body.kind === 'status' && body.tone === 'error') {
      // Start failures and dead agents land as error status rows; without them a wait reads "Done.".
      entries.push({ kind: 'error', text: String(body.text) })
    } else if (body.kind === 'tool-call') {
      entries.push({ kind: 'tool', name: body.name, state: body.state })
    } else if (body.kind === 'approval') {
      entries.push({
        kind: 'approval',
        text: body.title,
        pending: waiting(item, body.resolution.state)
      })
    } else if (body.kind === 'question') {
      entries.push({
        kind: 'question',
        // Grouped prompts keep their real questions in `questions`; `question` is then a heading.
        text: agentSessionPromptQuestions(body)
          .map((q) => q.question)
          .join('\n'),
        pending: waiting(item, body.resolution.state)
      })
    }
  }
  return entries
}

export function formatChatList(result: { chats: ChatSessionEntry[] }): string {
  if (result.chats.length === 0) {
    return 'No chats.'
  }
  return result.chats
    .map((chat) =>
      [
        `${chat.worktree} · ${chat.agentType ?? 'agent'} · ${chat.state}`,
        `  session: ${chat.session}`,
        ...(chat.title ? [`  title: ${chat.title}`] : []),
        ...(chat.lastAssistantMessage
          ? [`  last reply: ${chat.lastAssistantMessage.replace(/\s+/g, ' ').slice(0, 200)}`]
          : [])
      ].join('\n')
    )
    .join('\n\n')
}

export function formatChatRead(result: {
  session: string
  entries: ChatTranscriptEntry[]
}): string {
  if (result.entries.length === 0) {
    return `No messages in ${result.session}.`
  }
  return result.entries
    .map((entry) => {
      if (entry.kind === 'message') {
        return `${entry.role}: ${entry.text}`
      }
      if (entry.kind === 'error') {
        return `[error] ${entry.text}`
      }
      if (entry.kind === 'tool') {
        return `[tool ${entry.name}: ${entry.state}]`
      }
      return `[${entry.kind}${entry.pending ? ', waiting for you' : ''}] ${entry.text}`
    })
    .join('\n')
}
