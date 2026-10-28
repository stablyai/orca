import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type { Tab } from '../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { wslMoverProfile } from '../__fixtures__/wsl-mover/wsl-mover-profiles'
import { tabGroup, terminalTab } from '../__fixtures__/wsl-mover/wsl-mover-profile-rows'
import { createUncToLinuxPathRewriter } from './wsl-move-path-rewriter'
import { wslMoveRewriteScope } from './wsl-move-rewrite-scope'
import {
  withoutDesktopFocus,
  wslMoveHostSessionSeed,
  wslMoveReleasedSessionFocusPatch,
  wslMoveSessionGlobalsPatch
} from './wsl-move-session-rewrite'
import { prepareOrcadMigrationWorkspaceSession } from '../migrating-orcad-catalog/orcad-destination-workspace-session'

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
const SAME_DISTRO_ON_HOST = 'repo-b::/home/dev/lib'

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
  it("moves local focus on a moved workspace to the host's id and host", () => {
    expect(
      wslMoveSessionGlobalsPatch(
        {
          activeWorktreeId: MOVED,
          activeWorkspaceKey: `worktree:${MOVED}`,
          activeWorkspaceExecutionHostId: 'local'
        },
        scope
      )
    ).toEqual({
      activeWorktreeId: MOVED_ON_HOST,
      activeWorkspaceKey: `worktree:${MOVED_ON_HOST}`,
      activeWorkspaceExecutionHostId: HOST
    })
  })

  it("moves focus on a moved folder workspace to the host, keeping the folder's key", () => {
    expect(
      wslMoveSessionGlobalsPatch(
        {
          activeWorktreeId: null,
          activeWorkspaceKey: 'folder:folder-1',
          activeWorkspaceExecutionHostId: 'local'
        },
        scope
      )
    ).toEqual({ activeWorkspaceExecutionHostId: HOST })
    expect(
      wslMoveSessionGlobalsPatch(
        { activeWorktreeId: null, activeWorkspaceKey: 'folder:folder-2' },
        scope
      )
    ).toBeNull()
  })

  it('leaves focus on another project, or already on a host, alone', () => {
    const windows = 'repo-win::C:\\src\\win'
    expect(
      wslMoveSessionGlobalsPatch(
        { activeWorktreeId: windows, activeWorkspaceExecutionHostId: 'local' },
        scope
      )
    ).toBeNull()
    expect(
      wslMoveSessionGlobalsPatch(
        { activeWorktreeId: MOVED, activeWorkspaceExecutionHostId: 'ssh:box' },
        scope
      )
    ).toBeNull()
  })

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

  it('leaves focus on another host project, another host or this computer alone', () => {
    for (const focus of [
      { activeWorktreeId: SAME_DISTRO_ON_HOST, activeWorkspaceExecutionHostId: HOST },
      { activeWorktreeId: MOVED_ON_HOST, activeWorkspaceExecutionHostId: 'ssh:box' },
      { activeWorktreeId: MOVED, activeWorkspaceExecutionHostId: 'local' }
    ] as const) {
      expect(wslMoveReleasedSessionFocusPatch({ ...focus, tabsByWorktree: {} }, scope)).toBeNull()
    }
  })

  it('changes nothing on a second run', () => {
    const first = { activeWorktreeId: MOVED, activeWorkspaceExecutionHostId: null }
    const patch = wslMoveSessionGlobalsPatch(first, scope)

    expect(patch).toEqual({ activeWorktreeId: MOVED_ON_HOST, activeWorkspaceExecutionHostId: HOST })
    expect(wslMoveSessionGlobalsPatch({ ...first, ...patch }, scope)).toBeNull()
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
  it("seeds only the moved project's rows, without chats or PTY bindings", () => {
    const seed = seedSession(carriedSession(), getDefaultWorkspaceSession(), scope)

    expect(Object.keys(seed?.tabsByWorktree ?? {}).sort()).toEqual([MOVED_ON_HOST, FEATURE_ON_HOST])
    expect(seed?.tabsByWorktree[MOVED_ON_HOST]?.map((tab) => tab.ptyId)).toEqual([null])
    expect(seed?.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId).toBeUndefined()
    expect(seed?.terminalLayoutsByTabId['tab-1']?.titlesByLeafId).toEqual({
      'leaf-1': 'build',
      'leaf-2': 'claude'
    })
    expect(seed?.terminalLayoutsByTabId['tab-3']).toBeUndefined()
    expect(seed?.remoteSessionIdsByTabId ?? {}).toEqual({})
    expect(seed?.terminalPtyIncarnationsByPaneKey ?? {}).toEqual({})
    expect(seed?.activeWorktreeIdsOnShutdown ?? []).toEqual([])
    expect(seed?.unifiedTabs?.[MOVED_ON_HOST]?.map((tab) => tab.id)).not.toContain(chatTab.id)
    expect(seed?.tabGroups?.[MOVED_ON_HOST]?.[0]).toMatchObject({
      tabOrder: ['tab-1', '/home/dev/app/README.md'],
      activeTabId: 'tab-1',
      recentTabIds: ['tab-1']
    })
    expect(seed?.activeTabIdByWorktree?.[MOVED_ON_HOST]).toBeUndefined()
    expect(seed?.activeTabTypeByWorktree?.[MOVED_ON_HOST]).toBeUndefined()
    expect(seed?.openFilesByWorktree?.[MOVED_ON_HOST]?.[0]?.dirtyDraftContent).toBe(
      '# unsaved draft'
    )
    // Focus belongs to whoever looks at the host, not to the seed.
    expect(seed?.activeWorktreeId).toBeNull()
    expect(seed?.tabsByWorktree[SAME_DISTRO_ON_HOST]).toBeUndefined()
  })

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

  it('changes nothing on a second run', () => {
    const seed = seedSession(carriedSession(), getDefaultWorkspaceSession(), scope)

    if (!seed) {
      throw new Error('expected a seed')
    }
    expect(wslMoveHostSessionSeed(carriedSession(), seed, scope)).toBeNull()
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

describe('WSL move carried session focus', () => {
  // The focused project could not move into a host that had its own focus.
  it('carries no desktop focus, so a host with its own focus takes the moved project and keeps its focus', () => {
    const desktop: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: 'repo-moving',
      activeWorktreeId: 'repo-moving::/home/dev/app',
      activeWorkspaceKey: worktreeWorkspaceKey('repo-moving::/home/dev/app'),
      activeWorkspaceExecutionHostId: 'local',
      activeTabId: 'tab-1'
    }
    const carried = withoutDesktopFocus(desktop)
    expect(carried).toMatchObject({ activeRepoId: null, activeWorktreeId: null, activeTabId: null })
    expect('activeWorkspaceKey' in carried).toBe(false)
    expect('activeWorkspaceExecutionHostId' in carried).toBe(false)

    const host = {
      ...getDefaultPersistedState('/host-data'),
      workspaceSession: {
        ...getDefaultWorkspaceSession(),
        activeRepoId: 'repo-on-host',
        activeWorktreeId: 'repo-on-host::/home/dev/other',
        activeTabId: 'host-tab'
      }
    }
    const prepared = prepareOrcadMigrationWorkspaceSession(carried, host)
    expect(prepared.merged).toMatchObject({
      activeRepoId: 'repo-on-host',
      activeWorktreeId: 'repo-on-host::/home/dev/other',
      activeTabId: 'host-tab'
    })
    expect(() => prepareOrcadMigrationWorkspaceSession(desktop, host)).toThrow(
      'orcad_migration_dormant_focus_conflict'
    )
  })
})
