import { vi, type Mock } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { retireClaudeDispatchWaiters } from './claude-structured-dispatch'
import type { ClaudeSession } from './claude-structured-session-state'
import { ClaudeBackgroundTaskTracker } from './claude-background-task-tracker'
import { ClaudeSlashCommandCatalog } from './claude-slash-command-catalog'

export function sessionFor(send: Mock = vi.fn().mockResolvedValue(undefined)): ClaudeSession {
  return {
    connection: { send } as unknown as ClaudeSession['connection'],
    providerSessionId: 'provider-session',
    claudeConfigDir: '/accounts/claude',
    leafUuid: null,
    fence: 1,
    acquisitionGeneration: 'generation-1',
    prompts: {} as ClaudeSession['prompts'],
    dispatchWaiters: [],
    retiredDispatchWaiters: [],
    replayContentFallbackBlocked: false,
    backgroundTasks: new ClaudeBackgroundTaskTracker(),
    commands: new ClaudeSlashCommandCatalog(),
    dispatchSequence: 0,
    optionMutationSequence: 0,
    options: new Map(),
    reportedOptions: {},
    reportedModelMutation: 0,
    confirmedOptions: new Set(),
    restoreSkippedOptions: new Set(),
    capabilities: [],
    events: undefined,
    translator: null
  }
}

export function userMessage(blocks: AgentJournalMessageItem['blocks']): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks }
}

/** The child died. Nothing else retires a live waiter now that no deadline does. */
export function childExited(session: ClaudeSession): void {
  retireClaudeDispatchWaiters(session)
}

export function userReplayFrame(uuid: string, text: string): Record<string, unknown> {
  return {
    type: 'user',
    parent_tool_use_id: null,
    session_id: 'provider-session',
    uuid,
    message: { role: 'user', content: [{ type: 'text', text }] }
  }
}
