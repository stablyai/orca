import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import {
  CLIENT_HOSTED_BROWSER_PAGE_RECORD_VERSION,
  type PersistedClientHostedBrowserPage
} from '../../../shared/client-hosted-browser-page-record'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { PersistedOpenFile } from '../../../shared/workspace-session-state-types'
import { createOrcadMigrationManifest } from '../../ssh/orcad-migration-manifest-export'
import { orcadMigrationRefusalReason } from '../../ssh/orcad-migration-refusal-reason'
import { collectUntransferredDependentBlockers } from '../../ssh/targets/ssh-target-orcad-dependents'
import { collectOrcadMigrationUntransferredDependencyCensus } from './orcad-source-dependency-census'
import { collectOrcadMigrationSourceDormantState } from './orcad-source-dormant-state'

const TARGET = { id: 'ssh-prod', label: 'Prod', host: 'prod', port: 22, username: 'u' }
const HOST = 'ssh:ssh-prod'
const WORKTREE_A = 'remote-repo::/srv/repo'
const WORKTREE_B = 'remote-repo::/srv/repo-b'

function sourceState(): PersistedState {
  const state = getDefaultPersistedState('/home/user')
  state.sshTargets = [TARGET]
  state.repos = [
    {
      id: 'remote-repo',
      path: '/srv/repo',
      displayName: 'Remote',
      badgeColor: '#737373',
      addedAt: 1,
      connectionId: TARGET.id
    }
  ]
  state.workspaceSessionsByHostId = { [HOST]: getDefaultWorkspaceSession() }
  return state
}

function host(state: PersistedState) {
  return state.workspaceSessionsByHostId![HOST]!
}

function terminal(id: string, worktreeId = WORKTREE_A): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function openFile(overrides: Partial<PersistedOpenFile> = {}): PersistedOpenFile {
  return {
    filePath: '/srv/repo/notes.md',
    relativePath: 'notes.md',
    worktreeId: WORKTREE_A,
    language: 'markdown',
    ...overrides
  }
}

function browserWorkspace(
  id: string,
  worktreeId: string,
  overrides: Partial<BrowserWorkspace> = {}
): BrowserWorkspace {
  return {
    id,
    worktreeId,
    activePageId: `${id}-page`,
    pageIds: [`${id}-page`],
    url: 'https://example.test/',
    title: 'Example',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1,
    ...overrides
  }
}

function browserPage(workspaceId: string, worktreeId: string): BrowserPage {
  return {
    id: `${workspaceId}-page`,
    workspaceId,
    worktreeId,
    url: 'https://example.test/',
    title: 'Example',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

function unifiedTab(
  id: string,
  contentType: Tab['contentType'],
  entityId = id,
  overrides: Partial<Tab> = {}
): Tab {
  return {
    id,
    entityId,
    groupId: 'group-1',
    worktreeId: WORKTREE_A,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function group(tabOrder: string[], activeTabId: string): TabGroup {
  return { id: 'group-1', worktreeId: WORKTREE_A, activeTabId, tabOrder, recentTabIds: tabOrder }
}

function exportState(state: PersistedState) {
  return createOrcadMigrationManifest(
    {
      getRepos: () => state.repos,
      getFolderWorkspaces: () => state.folderWorkspaces,
      getProjectGroups: () => state.projectGroups,
      collectOrcadMigrationSourceDormantState: (source, catalog, destination) =>
        collectOrcadMigrationSourceDormantState(state, source, catalog, undefined, destination)
          .payload
    },
    TARGET,
    { destinationEnvironmentId: 'managed-prod' }
  )
}

function census(state: PersistedState) {
  return collectOrcadMigrationUntransferredDependencyCensus(state, exportState(state))
}

/** The Details line Settings shows for a refused move. */
function refusal(state: PersistedState): string {
  const manifest = exportState(state)
  return orcadMigrationRefusalReason(
    collectUntransferredDependentBlockers(
      {
        inspectOrcadMigrationUntransferredDependencies: (candidate) =>
          collectOrcadMigrationUntransferredDependencyCensus(state, candidate)
      },
      manifest
    )
  )
}

describe('#27281: saved tabs with no visible tab to close', () => {
  function reported(): PersistedState {
    const state = sourceState()
    const partition = host(state)
    // Every tab closed: the host copy keeps empty rows for each worktree.
    partition.tabsByWorktree = { [WORKTREE_A]: [], [WORKTREE_B]: [] }
    partition.unifiedTabs = { [WORKTREE_A]: [], [WORKTREE_B]: [] }
    partition.tabGroups = { [WORKTREE_A]: [], [WORKTREE_B]: [] }
    partition.openFilesByWorktree = { [WORKTREE_A]: [openFile()] }
    partition.browserTabsByWorktree = { [WORKTREE_B]: [browserWorkspace('browser-1', WORKTREE_B)] }
    partition.browserPagesByWorkspace = { 'browser-1': [browserPage('browser-1', WORKTREE_B)] }
    // Weeks-old terminals from before sessions were kept per host, in the desktop's own copy.
    state.workspaceSession.tabsByWorktree = {
      [WORKTREE_A]: [terminal('legacy-1'), terminal('legacy-2')],
      [WORKTREE_B]: [terminal('legacy-3', WORKTREE_B)]
    }
    return state
  }

  it('moves, carrying every leftover record instead of refusing', () => {
    const state = reported()
    const before = structuredClone(state)

    expect(census(state).totalCount).toBe(0)
    expect(refusal(state)).toBe('This SSH host cannot move yet.')
    const session = exportState(state).payload.dormantState?.workspaceSession
    expect(session?.tabsByWorktree[WORKTREE_A]?.map((tab) => tab.id)).toEqual([
      'legacy-1',
      'legacy-2'
    ])
    expect(session?.tabsByWorktree[WORKTREE_B]?.map((tab) => tab.id)).toEqual(['legacy-3'])
    expect(session?.openFilesByWorktree?.[WORKTREE_A]).toEqual([openFile()])
    expect(session?.browserTabsByWorktree?.[WORKTREE_B]?.map((tab) => tab.id)).toEqual([
      'browser-1'
    ])
    expect(state).toEqual(before)
  })

  // From #27526 (akushonkamen): the move never carries client-hosted pages.
  it('does not refuse on a client-hosted page whose browser tab is gone', () => {
    const state = sourceState()
    const page: PersistedClientHostedBrowserPage = {
      v: CLIENT_HOSTED_BROWSER_PAGE_RECORD_VERSION,
      browserPageId: 'page-1',
      workspaceId: 'gone-browser-workspace',
      browserProfileId: 'profile-1',
      url: 'https://example.test/',
      title: 'Example',
      pairedDeviceId: 'device-1',
      savedAt: 1
    }
    host(state).tabsByWorktree = { [WORKTREE_A]: [terminal('tab-1')] }
    host(state).clientHostedBrowserPagesByWorktree = { [WORKTREE_A]: [page] }
    const before = structuredClone(state)

    expect(census(state).totalCount).toBe(0)
    const session = exportState(state).payload.dormantState?.workspaceSession
    expect(session?.clientHostedBrowserPagesByWorktree ?? {}).toEqual({})
    expect(state).toEqual(before)
  })
})

describe('#28946: stale tab selections and isolated browser profiles', () => {
  it('leaves behind mobile selections that point at missing tabs', () => {
    const state = sourceState()
    host(state).tabsByWorktree = { [WORKTREE_A]: [terminal('tab-1')] }
    state.mobileClientTabSelectionsByDeviceId = {
      'runtime-device': {
        [`${HOST}|${WORKTREE_A}`]: {
          activeTabId: 'missing-1',
          activeGroupId: null,
          activeTabIdByGroupId: {}
        },
        [`${HOST}|${WORKTREE_B}`]: {
          activeTabId: 'missing-2',
          activeGroupId: 'missing-group',
          activeTabIdByGroupId: { 'missing-group': 'missing-3' }
        }
      }
    }
    const before = structuredClone(state)

    expect(census(state).totalCount).toBe(0)
    const clientState = exportState(state).payload.dormantState?.clientState
    expect(clientState?.mobileClientTabSelectionsByDeviceId).toBeUndefined()
    // The retained profile keeps them, device registration included.
    expect(state).toEqual(before)
  })

  // Every host a phone ever showed a terminal on: the phone names the pane, not the tab.
  it('carries a phone selection that names a live terminal pane', () => {
    const state = sourceState()
    host(state).tabsByWorktree = { [WORKTREE_A]: [terminal('tab-1')] }
    host(state).unifiedTabs = { [WORKTREE_A]: [unifiedTab('tab-1', 'terminal')] }
    host(state).tabGroups = { [WORKTREE_A]: [group(['tab-1'], 'tab-1')] }
    const selection = {
      activeTabId: 'tab-1::leaf-1',
      activeGroupId: 'group-1',
      activeTabIdByGroupId: { 'group-1': 'tab-1' }
    }
    state.mobileClientTabSelectionsByDeviceId = { phone: { [WORKTREE_A]: selection } }

    expect(census(state).totalCount).toBe(0)
    expect(
      exportState(state).payload.dormantState?.clientState?.mobileClientTabSelectionsByDeviceId
    ).toEqual({ phone: { [WORKTREE_A]: selection } })
  })

  it('keeps the part of a selection that still names a moved tab', () => {
    const state = sourceState()
    host(state).tabsByWorktree = { [WORKTREE_A]: [terminal('tab-1')] }
    state.mobileClientTabSelectionsByDeviceId = {
      phone: {
        [`${HOST}|${WORKTREE_A}`]: {
          activeTabId: 'tab-1',
          activeGroupId: 'missing-group',
          activeTabIdByGroupId: {}
        }
      }
    }
    expect(
      exportState(state).payload.dormantState?.clientState?.mobileClientTabSelectionsByDeviceId
    ).toEqual({
      phone: {
        [WORKTREE_A]: { activeTabId: 'tab-1', activeGroupId: null, activeTabIdByGroupId: {} }
      }
    })
  })

  function isolated(): PersistedState {
    const state = sourceState()
    const partition = host(state)
    partition.tabsByWorktree = { [WORKTREE_A]: [terminal('tab-1')] }
    partition.terminalLayoutsByTabId = {
      'tab-1': {
        root: { type: 'leaf', leafId: 'leaf' },
        activeLeafId: 'leaf',
        expandedLeafId: null
      }
    }
    partition.browserTabsByWorktree = {
      [WORKTREE_A]: [
        browserWorkspace('browser-work', WORKTREE_A, {
          sessionProfileId: 'work',
          sessionPartition: 'persist:orca-browser-session-work'
        }),
        browserWorkspace('browser-shared', WORKTREE_A)
      ]
    }
    partition.browserPagesByWorkspace = {
      'browser-work': [browserPage('browser-work', WORKTREE_A)],
      'browser-shared': [browserPage('browser-shared', WORKTREE_A)]
    }
    partition.activeBrowserTabIdByWorktree = { [WORKTREE_A]: 'browser-work' }
    partition.unifiedTabs = {
      [WORKTREE_A]: [
        unifiedTab('tab-1', 'terminal'),
        unifiedTab('browser-tab-work', 'browser', 'browser-work'),
        unifiedTab('browser-tab-shared', 'browser', 'browser-shared')
      ]
    }
    partition.tabGroups = {
      [WORKTREE_A]: [group(['tab-1', 'browser-tab-work', 'browser-tab-shared'], 'browser-tab-work')]
    }
    state.ui.acknowledgedAgentsByPaneKey = { 'tab-1:leaf': 1, 'tab-1:leaf-2': 2, 'tab-1:leaf-3': 3 }
    return state
  }

  it('moves without the isolated-profile browser tab, and without a sidebar refusal', () => {
    const state = isolated()
    const before = structuredClone(state)

    expect(census(state).totalCount).toBe(0)
    const dormant = exportState(state).payload.dormantState
    const session = dormant?.workspaceSession
    expect(session?.browserTabsByWorktree?.[WORKTREE_A]?.map((tab) => tab.id)).toEqual([
      'browser-shared'
    ])
    expect(Object.keys(session?.browserPagesByWorkspace ?? {})).toEqual(['browser-shared'])
    expect(session?.activeBrowserTabIdByWorktree?.[WORKTREE_A]).toBeUndefined()
    expect(session?.unifiedTabs?.[WORKTREE_A]?.map((tab) => tab.id)).toEqual([
      'tab-1',
      'browser-tab-shared'
    ])
    expect(session?.tabGroups?.[WORKTREE_A]).toEqual([
      {
        id: 'group-1',
        worktreeId: WORKTREE_A,
        activeTabId: 'browser-tab-shared',
        tabOrder: ['tab-1', 'browser-tab-shared'],
        recentTabIds: ['tab-1', 'browser-tab-shared']
      }
    ])
    // The acknowledgements were only ever refused as a knock-on of the browser tab.
    expect(dormant?.clientState?.uiRouting?.acknowledgedAgentsByPaneKey).toEqual(
      state.ui.acknowledgedAgentsByPaneKey
    )
    // The retained profile keeps the isolated tab and its profile.
    expect(state).toEqual(before)
  })

  it('carries a tab switched back to the shared default profile', () => {
    const state = isolated()
    host(state).browserTabsByWorktree![WORKTREE_A][0] = browserWorkspace(
      'browser-work',
      WORKTREE_A,
      { sessionProfileId: null, sessionPartition: 'persist:orca-browser' }
    )

    expect(census(state).totalCount).toBe(0)
    const session = exportState(state).payload.dormantState?.workspaceSession
    expect(session?.browserTabsByWorktree?.[WORKTREE_A]?.map((tab) => tab.id)).toEqual([
      'browser-work',
      'browser-shared'
    ])
  })
})

describe('live work still refuses, naming what blocks', () => {
  it('refuses an unsaved draft the server cannot hold and says how to clear it', () => {
    const state = sourceState()
    host(state).openFilesByWorktree = {
      [WORKTREE_A]: [
        openFile({
          filePath: '/etc/hosts',
          externalSshTargetId: TARGET.id,
          dirtyDraftContent: 'unsaved'
        })
      ]
    }

    expect(census(state).counts['workspace-session']).toBe(1)
    expect(refusal(state)).toBe(
      'This SSH host cannot move yet: saved tabs and panes (unsaved changes to /etc/hosts in /srv/repo: save or discard them).'
    )
  })

  it('refuses a tab another host runs and names it', () => {
    const state = sourceState()
    host(state).unifiedTabs = {
      [WORKTREE_A]: [unifiedTab('tab-1', 'terminal', 'tab-1', { executionHostId: 'runtime:env-2' })]
    }
    host(state).tabGroups = { [WORKTREE_A]: [group(['tab-1'], 'tab-1')] }

    expect(refusal(state)).toBe(
      'This SSH host cannot move yet: saved tabs and panes (the tab "tab-1" in /srv/repo, which another host runs: close it).'
    )
  })

  it('refuses a resume record behind a worker fence', () => {
    const state = sourceState()
    // Older profiles still carry the fence, which the record type no longer models.
    const fenced = { automaticResumeBlockedBy: 'worker-owner' }
    host(state).sleepingAgentSessionsByPaneKey = {
      'closed:leaf': {
        ...fenced,
        paneKey: 'closed:leaf',
        tabId: 'closed',
        worktreeId: WORKTREE_A,
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'session-1' },
        prompt: 'Saved prompt',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'quit'
      }
    }

    expect(refusal(state)).toContain('a codex session saved in /srv/repo')
  })

  it('leaves behind a clean host-bound editor file no tab shows, but refuses a visible one', () => {
    const state = sourceState()
    const external = openFile({ filePath: '/etc/hosts', externalSshTargetId: TARGET.id })
    host(state).openFilesByWorktree = { [WORKTREE_A]: [external] }
    host(state).unifiedTabs = { [WORKTREE_A]: [] }
    host(state).tabGroups = { [WORKTREE_A]: [] }

    expect(census(state).totalCount).toBe(0)
    expect(
      exportState(state).payload.dormantState?.workspaceSession?.openFilesByWorktree?.[WORKTREE_A]
    ).toEqual([])

    host(state).unifiedTabs = { [WORKTREE_A]: [unifiedTab('/etc/hosts', 'editor')] }
    host(state).tabGroups = { [WORKTREE_A]: [group(['/etc/hosts'], '/etc/hosts')] }
    expect(refusal(state)).toBe(
      'This SSH host cannot move yet: saved tabs and panes (the editor tab for /etc/hosts, which another host opened: close it).'
    )
  })
})
