import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import type { Worktree } from '../worktree/workspace-list-types'
import type { ConversationHistory } from './project-conversations'

export function conversationAgent(
  overrides: Partial<RuntimeWorktreeAgentRow> = {}
): RuntimeWorktreeAgentRow {
  return {
    paneKey: 'chat-pane',
    parentPaneKey: null,
    state: 'done',
    agentType: 'codex',
    prompt: 'Make the navigation clearer',
    taskTitle: 'Clearer navigation',
    displayName: null,
    lastAssistantMessage: 'Updated the list',
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 100,
    updatedAt: 100,
    ...overrides
  }
}

export function conversationWorkspace(overrides: Partial<Worktree> = {}): Worktree {
  return {
    worktreeId: 'atlas::/projects/atlas',
    repoId: 'atlas',
    hostId: 'local',
    repo: 'Atlas',
    path: '/projects/atlas',
    branch: 'feat/private-branch',
    displayName: 'feat/private-branch',
    liveTerminalCount: 1,
    hasAttachedPty: true,
    unread: false,
    isPinned: false,
    linkedPR: { number: 42, state: 'open' },
    isMainWorktree: true,
    ...overrides
  }
}

export function conversationHistory(
  overrides: Partial<ConversationHistory> = {}
): ConversationHistory {
  return {
    id: 'history-one',
    executionHostId: 'local',
    sessionId: 'provider-one',
    agent: 'claude',
    title: 'Improve the onboarding',
    cwd: '/projects/atlas',
    updatedAt: null,
    previewMessages: [],
    modifiedAt: '2026-10-24T12:00:00Z',
    ...overrides
  }
}
