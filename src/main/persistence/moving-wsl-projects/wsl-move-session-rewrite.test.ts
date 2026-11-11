import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import type { Tab } from '../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { wslMoverProfile } from '../__fixtures__/wsl-mover/wsl-mover-profiles'
import { tabGroup, terminalTab } from '../__fixtures__/wsl-mover/wsl-mover-profile-rows'
import { createUncToLinuxPathRewriter } from './wsl-move-path-rewriter'
import { wslMoveRewriteScope } from './wsl-move-rewrite-scope'
import {
  wslMoveHostSessionSeed,
  wslMoveReleasedSessionFocusPatch
} from './wsl-move-session-rewrite'

const HOST = toRuntimeExecutionHostId('wsl:Ubuntu')
const scope = wslMoveRewriteScope({
  cutover: wslMoveCutoverFixture(
    'move-1',
    'destination-committed',
    {},
    { repoIds: ['repo-a'], folderWorkspaceIds: ['folder-1'] }
  ),
  rewritePath: createUncToLinuxPathRewriter('Ubuntu'),
  destinationHostId: HOST,
  recordSeededHostWorkspaceIds: () => {}
})

const source = wslMoverProfile('mixed-windows-wsl', 'source')
const MOVED = source.session.activeWorktreeId ?? ''
const MOVED_ON_HOST = 'repo-a::/home/dev/app'
const FEATURE_ON_HOST = 'repo-a::/home/dev/app-feature'

const chatTab: Tab = {
  id: 'chat-1',
  entityId: 'agent-session-1',
  groupId: 'group-1',
  worktreeId: MOVED_ON_HOST,
  contentType: 'agent-session',
  label: 'Claude',
  customLabel: null,
  color: null,
  sortOrder: 1,
  createdAt: 0
}

/** The session the move carried, as the manifest holds it: host ids, a chat, live PTY ids. */
function carriedSession(): WorkspaceSessionState {
  const carried: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    ...wslMoverProfile('mixed-windows-wsl', 'destination').session
  }
  const group = carried.tabGroups?.[MOVED_ON_HOST]?.[0]
  return {
    ...carried,
    unifiedTabs: {
      ...carried.unifiedTabs,
      [MOVED_ON_HOST]: [...(carried.unifiedTabs?.[MOVED_ON_HOST] ?? []), chatTab]
    },
    tabGroups: {
      [MOVED_ON_HOST]: group
        ? [
            {
              ...group,
              tabOrder: [...group.tabOrder, chatTab.id],
              activeTabId: chatTab.id,
              recentTabIds: ['tab-1', chatTab.id]
            }
          ]
        : []
    },
    activeTabIdByWorktree: { [MOVED_ON_HOST]: chatTab.id },
    activeTabTypeByWorktree: { [MOVED_ON_HOST]: 'agent-session' }
  }
}

describe('WSL move session globals', () => {
  // verify-15b 6c: undo left focus on the host copy, which reopened and resumed its agent.
  it("returns focus on a released project's host copy to its copy here", () => {
    const tabsByWorktree = { [MOVED]: [], 'repo-win::C:\\src\\win': [] }
    expect(
      wslMoveReleasedSessionFocusPatch(
        {
          activeWorktreeId: MOVED_ON_HOST,
          activeWorkspaceKey: `worktree:${MOVED_ON_HOST}`,
          activeWorkspaceExecutionHostId: HOST,
          tabsByWorktree
        },
        scope
      )
    ).toEqual({
      activeWorkspaceExecutionHostId: 'local',
      activeWorktreeId: MOVED,
      activeWorkspaceKey: `worktree:${MOVED}`
    })
    expect(
      wslMoveReleasedSessionFocusPatch(
        {
          activeWorktreeId: null,
          activeWorkspaceKey: 'folder:folder-1',
          activeWorkspaceExecutionHostId: HOST,
          tabsByWorktree
        },
        scope
      )
    ).toEqual({ activeWorkspaceExecutionHostId: 'local' })
    // Nothing here to return to: focus leaves the host copy rather than reopen it.
    expect(
      wslMoveReleasedSessionFocusPatch(
        {
          activeWorktreeId: MOVED_ON_HOST,
          activeWorkspaceExecutionHostId: HOST,
          tabsByWorktree: {}
        },
        scope
      )
    ).toEqual({
      activeWorkspaceExecutionHostId: 'local',
      activeWorktreeId: null,
      activeWorkspaceKey: null
    })
  })
})

/** The seeded partition alone. */
function seedSession(
  carried: WorkspaceSessionState,
  existing: WorkspaceSessionState,
  seedScope: typeof scope
): WorkspaceSessionState | null {
  return wslMoveHostSessionSeed(carried, existing, seedScope)?.session ?? null
}

describe('WSL move host session seed', () => {
  it('never replaces what the host already published', () => {
    const published: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: MOVED_ON_HOST,
      tabsByWorktree: {
        [MOVED_ON_HOST]: [terminalTab('host-tab', MOVED_ON_HOST, null, 'host-pty')]
      },
      terminalLayoutsByTabId: {
        'host-tab': { root: null, activeLeafId: null, expandedLeafId: null }
      },
      tabGroups: { [MOVED_ON_HOST]: [tabGroup('host-group', MOVED_ON_HOST, ['host-tab'])] }
    }
    const seed = seedSession(carriedSession(), published, scope)

    expect(seed?.tabsByWorktree[MOVED_ON_HOST]).toEqual(published.tabsByWorktree[MOVED_ON_HOST])
    expect(seed?.tabGroups).toEqual(published.tabGroups)
    expect(seed?.terminalLayoutsByTabId['tab-1']).toBeUndefined()
    expect(seed?.tabsByWorktree[FEATURE_ON_HOST]?.map((tab) => tab.id)).toEqual(['tab-2'])
    expect(seed?.activeWorktreeId).toBe(MOVED_ON_HOST)
  })

  it('never seeds a workspace an earlier run recorded, even once its tabs are closed', () => {
    const first = wslMoveHostSessionSeed(carriedSession(), getDefaultWorkspaceSession(), scope)

    expect(first?.workspaceIds.sort()).toEqual([MOVED_ON_HOST, FEATURE_ON_HOST])
    expect(
      wslMoveHostSessionSeed(
        carriedSession(),
        getDefaultWorkspaceSession(),
        scope,
        new Set(first?.workspaceIds)
      )
    ).toBeNull()
  })

  it('drops a group that held only chats, with the layout and focus that named it', () => {
    const carried = carriedSession()
    const workGroup = carried.tabGroups?.[MOVED_ON_HOST]?.[0]
    const chatGroup = tabGroup('chat-group', MOVED_ON_HOST, [chatTab.id])
    const seed = seedSession(
      {
        ...carried,
        unifiedTabs: {
          ...carried.unifiedTabs,
          [MOVED_ON_HOST]: [
            ...(carried.unifiedTabs?.[MOVED_ON_HOST] ?? []).filter((tab) => tab.id !== chatTab.id),
            { ...chatTab, groupId: chatGroup.id }
          ]
        },
        tabGroups: {
          [MOVED_ON_HOST]: [
            ...(workGroup
              ? [{ ...workGroup, tabOrder: workGroup.tabOrder.filter((id) => id !== chatTab.id) }]
              : []),
            chatGroup
          ]
        },
        tabGroupLayouts: {
          [MOVED_ON_HOST]: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: 'group-1' },
            second: { type: 'leaf', groupId: chatGroup.id }
          }
        },
        activeGroupIdByWorktree: { [MOVED_ON_HOST]: chatGroup.id }
      },
      getDefaultWorkspaceSession(),
      scope
    )

    expect(seed?.tabGroups?.[MOVED_ON_HOST]?.map((group) => group.id)).toEqual(['group-1'])
    expect(seed?.tabGroupLayouts?.[MOVED_ON_HOST]).toEqual({ type: 'leaf', groupId: 'group-1' })
    expect(seed?.activeGroupIdByWorktree?.[MOVED_ON_HOST]).toBe('group-1')
  })
})
