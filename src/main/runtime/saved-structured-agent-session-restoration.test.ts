import { describe, expect, it } from 'vitest'
import type { Tab } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { collectSavedStructuredAgentSessionIds } from './saved-structured-agent-session-restoration'

function tab(input: Partial<Tab> & Pick<Tab, 'id'>): Tab {
  const { id, ...overrides } = input
  return {
    id,
    entityId: input.entityId ?? id,
    groupId: 'group-1',
    worktreeId: 'workspace-1',
    contentType: 'agent-session',
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function session(tabs: Tab[], activeTabId: string | null): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: 'workspace-1',
    activeTabId,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabs: { 'workspace-1': tabs },
    activeTabIdByWorktree: { 'workspace-1': activeTabId }
  }
}

describe('saved structured session restoration targets', () => {
  it('prioritizes the visible chat and excludes closed history', () => {
    const saved = session(
      [
        tab({ id: 'tab-background', structuredSessionId: 'session-background' }),
        tab({ id: 'tab-visible', structuredSessionId: 'session-visible' })
      ],
      'tab-visible'
    )

    expect(collectSavedStructuredAgentSessionIds(saved)).toEqual([
      'session-visible',
      'session-background'
    ])
    expect(collectSavedStructuredAgentSessionIds(session([], null))).toEqual([])
  })

  it('keeps restoration on the local execution host and deduplicates adopted tabs', () => {
    const saved = session(
      [
        tab({ id: 'remote', executionHostId: 'ssh:build', structuredSessionId: 'session-remote' }),
        tab({ id: 'local-a', structuredSessionId: 'session-local' }),
        tab({
          id: 'local-b',
          contentType: 'terminal',
          structuredSessionId: 'session-local'
        })
      ],
      'remote'
    )

    expect(collectSavedStructuredAgentSessionIds(saved)).toEqual(['session-local'])
  })

  it('skips explicitly Claude-owned structured tabs', () => {
    const saved = session(
      [
        tab({
          id: 'claude-tab',
          agentSessionAgent: 'claude',
          structuredSessionId: 'session-claude'
        }),
        tab({
          id: 'codex-tab',
          agentSessionAgent: 'codex',
          structuredSessionId: 'session-codex'
        })
      ],
      'claude-tab'
    )

    expect(collectSavedStructuredAgentSessionIds(saved)).toEqual(['session-codex'])
  })
})
