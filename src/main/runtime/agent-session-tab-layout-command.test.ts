import { describe, expect, it } from 'vitest'
import type { Tab } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { chatTabLayoutCommand, loadChatTabLayout } from './agent-session/agent-session-tab-layout'

const WT = 'repo-1::/tmp/worktree-a'

function chatTab(sessionId: string, id: string): Tab {
  return {
    id,
    entityId: sessionId,
    groupId: 'group-1',
    worktreeId: WT,
    contentType: 'agent-session',
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function session(tabs: Tab[], activeGroupId?: string): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabs: { [WT]: tabs },
    tabGroups: {
      [WT]: [{ id: 'group-1', worktreeId: WT, activeTabId: null, tabOrder: tabs.map((t) => t.id) }]
    },
    ...(activeGroupId ? { activeGroupIdByWorktree: { [WT]: activeGroupId } } : {})
  }
}

/** The command for `change` against `stored` as main loads it. */
function commandOn(
  stored: WorkspaceSessionState,
  change: Parameters<typeof chatTabLayoutCommand>[3]
) {
  const { loaded, activeGroupId } = loadChatTabLayout('local', stored, WT)
  return chatTabLayoutCommand(loaded.layout.workspaces[WT], activeGroupId, WT, change)
}

const open = (sessionId: string) => ({
  open: { sessionId, agent: 'codex' as const, tabId: `agent-session:${sessionId}` }
})

describe("a host's chat tab change as main's layout command", () => {
  it("opens a listed chat in the workspace's remembered active group", () => {
    expect(commandOn(session([chatTab('a', 'saved-tab')], 'group-1'), open('b'))).toEqual({
      type: 'openAgentSessionTab',
      workspace: WT,
      tabId: 'agent-session:b',
      sessionId: 'b',
      agent: 'codex',
      groupId: 'group-1'
    })
  })

  it('names no group the workspace no longer holds, nor one with no layout loaded', () => {
    expect(commandOn(session([chatTab('a', 'saved-tab')], 'gone'), open('b'))).toEqual(
      expect.not.objectContaining({ groupId: expect.anything() })
    )
    expect(chatTabLayoutCommand(undefined, 'group-1', WT, open('b'))).toEqual(
      expect.not.objectContaining({ groupId: expect.anything() })
    )
  })

  describe("a paired client's chosen place (L270)", () => {
    /** Two groups: group-1 holds [a, c], group-2 holds [d]; group-1 is remembered active. */
    function twoGroups(): WorkspaceSessionState {
      const tabs = [
        chatTab('a', 'tab-a'),
        chatTab('c', 'tab-c'),
        { ...chatTab('d', 'tab-d'), groupId: 'group-2' }
      ]
      return {
        ...session(tabs, 'group-1'),
        tabGroups: {
          [WT]: [
            { id: 'group-1', worktreeId: WT, activeTabId: null, tabOrder: ['tab-a', 'tab-c'] },
            { id: 'group-2', worktreeId: WT, activeTabId: null, tabOrder: ['tab-d'] }
          ]
        }
      }
    }
    const placed = (placement: { groupId?: string; afterTabId?: string }) => ({
      open: { ...open('b').open, placement }
    })

    it('opens the chat in the named group, after the named tab', () => {
      expect(commandOn(twoGroups(), placed({ groupId: 'group-1', afterTabId: 'tab-a' }))).toEqual({
        type: 'openAgentSessionTab',
        workspace: WT,
        tabId: 'agent-session:b',
        sessionId: 'b',
        agent: 'codex',
        groupId: 'group-1',
        afterTabId: 'tab-a'
      })
    })

    it('prefers the named group to the remembered active one', () => {
      expect(commandOn(twoGroups(), placed({ groupId: 'group-2' }))).toMatchObject({
        groupId: 'group-2'
      })
    })

    it('falls back to the active group for a group the workspace no longer holds', () => {
      expect(
        commandOn(twoGroups(), placed({ groupId: 'gone', afterTabId: 'tab-a' }))
      ).toMatchObject({
        groupId: 'group-1',
        afterTabId: 'tab-a'
      })
    })

    it('drops an anchor tab that is not in the chosen group', () => {
      expect(commandOn(twoGroups(), placed({ groupId: 'group-2', afterTabId: 'tab-a' }))).toEqual(
        expect.not.objectContaining({ afterTabId: expect.anything() })
      )
    })
  })

  it('opens nothing for a chat a tab already shows', () => {
    expect(commandOn(session([chatTab('a', 'saved-tab')], 'group-1'), open('a'))).toBeNull()
  })

  it('closes the tab that shows the chat, under its saved id, forced', () => {
    expect(commandOn(session([chatTab('a', 'saved-tab')]), { close: 'a' })).toEqual({
      type: 'closeTabs',
      workspace: WT,
      tabIds: ['saved-tab'],
      force: true
    })
  })

  it('closes nothing for a chat no tab shows', () => {
    expect(commandOn(session([chatTab('a', 'saved-tab')]), { close: 'b' })).toBeNull()
  })
})
