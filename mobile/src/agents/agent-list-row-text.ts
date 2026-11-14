import { getAgentRowPrimaryText } from '../../../src/shared/agent-status/presentation/agent-row-primary-text'
import { formatAgentToolPreviewLine } from '../../../src/shared/agent-status/presentation/agent-tool-preview'
import { formatAgentTypeLabel } from '../../../src/shared/agent-status/presentation/agent-type-label'
import { withoutNativeChatVisualDirectiveLines } from '../../../src/shared/native-chat/native-chat-visual-directive'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import type { HomeAgentEntry } from '../worktree/home-worktree-info'
import type { AgentStatusGroup } from './agent-list-rows'

/** The row's name: what the conversation is called, else its task, else what it was asked. */
export function agentListTitle(agent: RuntimeWorktreeAgentRow): string {
  return (
    agent.conversationName?.trim() ||
    agent.displayName?.trim() ||
    agent.taskTitle?.trim() ||
    getAgentRowPrimaryText({ prompt: agent.prompt }) ||
    formatAgentTypeLabel(agent.agentType)
  )
}

function oneLine(text: string | null | undefined): string {
  return text?.replace(/\s+/g, ' ').trim() ?? ''
}

// A worktree agent row or a session tab's AgentStatusEntry, which leaves these optional.
type AgentPreviewSource = Pick<RuntimeWorktreeAgentRow, 'prompt'> & {
  lastAssistantMessage?: string | null
  toolName?: string | null
  toolInput?: string | null
}

function lastMessage(agent: AgentPreviewSource): string {
  const message = agent.lastAssistantMessage
  return message ? oneLine(withoutNativeChatVisualDirectiveLines(message)) : ''
}

/**
 * The row's second line: what it waits on or is doing, else what it last said. A last-seen row
 * (`group` null) shows no tool, since the tool call is long over.
 */
export function agentListPreview(
  agent: AgentPreviewSource,
  group: AgentStatusGroup | null,
  title: string
): string {
  const tool = group === null ? '' : oneLine(formatAgentToolPreviewLine(agent, false))
  const preview =
    group === 'needs-you' || group === 'working'
      ? tool || lastMessage(agent)
      : lastMessage(agent) || tool
  if (preview) {
    return preview
  }
  const prompt = oneLine(getAgentRowPrimaryText({ prompt: agent.prompt }))
  return prompt === title ? '' : prompt
}

/** Search covers what the row shows plus the prompt; `query` is already lower-cased. */
export function agentListEntryMatches(entry: HomeAgentEntry, query: string): boolean {
  const { agent } = entry
  return [
    agentListTitle(agent),
    agent.activity?.listed === true ? agent.activity.title : null,
    entry.workspaceName,
    entry.branch,
    entry.repo,
    formatAgentTypeLabel(agent.agentType),
    agent.prompt,
    agent.lastAssistantMessage
  ].some((field) => field?.toLowerCase().includes(query))
}
