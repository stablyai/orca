import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { withChatTabChanges, type ChatTabChange } from './agent-session-tab-layout'

const WT = 'repo-1::/tmp/worktree-a'

const EMPTY: WorkspaceSessionState = {
  activeRepoId: 'repo-1',
  activeWorktreeId: WT,
  activeTabId: null,
  tabsByWorktree: {},
  terminalLayoutsByTabId: {}
}

function open(sessionId: string, tabId = `structured-agent-session-${sessionId}`): ChatTabChange {
  return { open: { sessionId, agent: 'codex', tabId } }
}

function change(session: WorkspaceSessionState, changes: ChatTabChange[]): WorkspaceSessionState {
  const next = withChatTabChanges('local', session, WT, changes)
  if (!next) {
    throw new Error('nothing changed')
  }
  return next
}

describe('a windowless host’s chat tab saves', () => {
  it('open a chat in a freshly minted group once the last one closed', () => {
    const first = change(EMPTY, [open('chat-a')])
    const firstGroup = first.tabGroups?.[WT]?.[0]?.id
    const closed = change(first, [{ close: 'chat-a' }])
    // The workspace keeps no group, but its saved view still names the closed chat's group.
    const remembering = {
      ...closed,
      activeGroupIdByWorktree: { ...closed.activeGroupIdByWorktree, [WT]: firstGroup! }
    }
    expect(remembering.tabGroups?.[WT] ?? []).toEqual([])
    const reopened = change(remembering, [open('chat-b')])
    const groups = reopened.tabGroups?.[WT] ?? []
    expect(firstGroup).toBeTruthy()
    expect(groups).toHaveLength(1)
    expect(groups[0]?.id).not.toBe(firstGroup)
  })

  // Preserved legacy behaviour: with the build switch off a duplicate chat tab id is still saved.
  it('save a chat whose tab id another tab already holds, as they always have', () => {
    const saved = change(EMPTY, [open('chat-a', 'structured-agent-session-shared')])
    const both = change(saved, [open('chat-b', 'structured-agent-session-shared')])
    expect(
      (both.unifiedTabs?.[WT] ?? [])
        .filter((tab) => tab.contentType === 'agent-session')
        .map((tab) => tab.entityId)
        .sort()
    ).toEqual(['chat-a', 'chat-b'])
  })
})
