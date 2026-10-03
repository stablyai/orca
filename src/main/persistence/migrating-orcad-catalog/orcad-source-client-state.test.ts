import { describe, expect, it } from 'vitest'
import type { OrcadMigrationCatalogPayload } from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { BrowserWorkspace } from '../../../shared/browser-workspace-types'
import {
  CLIENT_HOSTED_BROWSER_PAGE_RECORD_VERSION,
  type PersistedClientHostedBrowserPage
} from '../../../shared/client-hosted-browser-page-record'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { collectOrcadMigrationSourceClientState } from './orcad-source-client-state'

const source = {
  sshTargetId: 'target-1',
  sshTargetGeneration: 3,
  targetLabel: 'Build host'
}
const catalog: OrcadMigrationCatalogPayload = {
  repositories: [
    {
      id: 'repo-1',
      path: '/srv/repo-1',
      displayName: 'Repo',
      badgeColor: '#737373',
      addedAt: 1,
      connectionId: source.sshTargetId,
      executionHostId: 'ssh:target-1'
    }
  ],
  projectGroups: [],
  folderWorkspaces: []
}

function state(): PersistedState {
  const persisted = getDefaultPersistedState('/home/test')
  persisted.sshTargets = [
    {
      id: source.sshTargetId,
      label: source.targetLabel,
      host: 'source.example.com',
      port: 22,
      username: 'deploy',
      portForwards: []
    }
  ]
  return persisted
}

function terminalTab(id: string, worktreeId: string): TerminalTab {
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

function session(
  fields: Pick<WorkspaceSessionState, 'tabsByWorktree'> & Partial<WorkspaceSessionState>
): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), tabGroups: {}, ...fields }
}

function browserWorkspace(id: string, worktreeId: string): BrowserWorkspace {
  return {
    id,
    worktreeId,
    url: 'about:blank',
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

function hostedPage(browserPageId: string, workspaceId: string): PersistedClientHostedBrowserPage {
  return {
    v: CLIENT_HOSTED_BROWSER_PAGE_RECORD_VERSION,
    browserPageId,
    workspaceId,
    browserProfileId: 'default',
    url: 'about:blank',
    title: browserPageId,
    pairedDeviceId: 'device-1',
    savedAt: 1
  }
}

describe('source client-state migration', () => {
  it('rekeys representable mobile selections and desktop routing', () => {
    const current = state()
    current.mobileClientTabSelectionsByDeviceId = {
      phone: {
        'ssh:target-1|repo-1::/srv/worktree': {
          activeTabId: 'tab-1',
          activeGroupId: null,
          activeTabIdByGroupId: {}
        }
      }
    }
    current.ui.lastActiveRepoId = 'repo-1'
    current.ui.lastActiveWorktreeId = 'ssh:target-1|repo-1::/srv/worktree'
    current.ui.workspaceHostScope = 'ssh:target-1'
    current.ui.showDotfilesByWorktree = {
      'ssh:target-1|repo-1::/srv/worktree': false
    }
    const scoped = session({
      tabsByWorktree: {
        'ssh:target-1|repo-1::/srv/worktree': [
          terminalTab('tab-1', 'ssh:target-1|repo-1::/srv/worktree')
        ]
      },
      tabGroups: {}
    })

    const result = collectOrcadMigrationSourceClientState(
      current,
      source,
      catalog,
      'environment-1',
      scoped
    )
    expect(result.blockedCounts).toEqual({
      'mobile-tab-selection': 0,
      'ui-routing': 0,
      'saved-port-forward': 0
    })
    expect(result.payload?.mobileClientTabSelectionsByDeviceId).toMatchObject({
      phone: { 'repo-1::/srv/worktree': { activeTabId: 'tab-1' } }
    })
    expect(result.payload?.uiRouting).toMatchObject({
      lastActiveRepoId: 'repo-1',
      lastActiveWorktreeId: 'repo-1::/srv/worktree',
      workspaceHostScope: 'local',
      showDotfilesByWorktree: { 'repo-1::/srv/worktree': false }
    })
  })

  it('blocks a mobile selection that points at a group outside the migrated owner', () => {
    const current = state()
    const sourceOwner = 'ssh:target-1|repo-1::/srv/worktree'
    const unrelatedOwner = 'ssh:target-1|repo-2::/srv/other'
    current.mobileClientTabSelectionsByDeviceId = {
      phone: {
        [sourceOwner]: {
          activeTabId: null,
          activeGroupId: 'group-unrelated',
          activeTabIdByGroupId: {}
        }
      }
    }
    const scoped = session({
      tabsByWorktree: {},
      tabGroups: {
        [unrelatedOwner]: [
          {
            id: 'group-unrelated',
            worktreeId: unrelatedOwner,
            activeTabId: null,
            tabOrder: []
          }
        ]
      }
    })

    const result = collectOrcadMigrationSourceClientState(
      current,
      source,
      catalog,
      'environment-1',
      scoped
    )

    expect(result.payload?.mobileClientTabSelectionsByDeviceId).toBeUndefined()
    expect(result.blockedCounts['mobile-tab-selection']).toBe(1)
  })

  it('blocks a per-group tab selection whose group is outside the migrated owner', () => {
    const current = state()
    const sourceOwner = 'ssh:target-1|repo-1::/srv/worktree'
    const unrelatedOwner = 'ssh:target-1|repo-2::/srv/other'
    current.mobileClientTabSelectionsByDeviceId = {
      phone: {
        [sourceOwner]: {
          activeTabId: null,
          activeGroupId: null,
          activeTabIdByGroupId: { 'group-unrelated': 'tab-source' }
        }
      }
    }
    const scoped = session({
      tabsByWorktree: {
        [sourceOwner]: [terminalTab('tab-source', sourceOwner)]
      },
      tabGroups: {
        [unrelatedOwner]: [
          {
            id: 'group-unrelated',
            worktreeId: unrelatedOwner,
            activeTabId: 'tab-source',
            tabOrder: ['tab-source']
          }
        ]
      }
    })

    const result = collectOrcadMigrationSourceClientState(
      current,
      source,
      catalog,
      'environment-1',
      scoped
    )

    expect(result.payload?.mobileClientTabSelectionsByDeviceId).toBeUndefined()
    expect(result.blockedCounts['mobile-tab-selection']).toBe(1)
  })

  it('captures saved forwards and reports duplicate local ports', () => {
    const current = state()
    current.sshTargets[0].portForwards = [
      { localPort: 9000, remoteHost: '127.0.0.1', remotePort: 6768 },
      { localPort: 9000, remoteHost: '127.0.0.1', remotePort: 6769 }
    ]
    const result = collectOrcadMigrationSourceClientState(
      current,
      source,
      catalog,
      undefined,
      undefined
    )
    expect(result.payload?.savedPortForwards).toHaveLength(2)
    expect(result.blockedCounts['saved-port-forward']).toBe(1)
  })

  it('captures only close intents for transferred client-hosted pages', () => {
    const current = state()
    const worktreeId = 'ssh:target-1|repo-1::/srv/worktree'
    current.workspaceSession = session({
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      browserTabsByWorktree: {
        [worktreeId]: [browserWorkspace('browser-1', worktreeId)]
      },
      clientHostedBrowserPagesByWorktree: {
        [worktreeId]: [hostedPage('page-1', 'browser-1')]
      },
      clientHostedBrowserCloseIntentsByEnvironment: {
        'old-environment': [
          { browserPageId: 'page-1', worktreeId, closedAt: 42 },
          { browserPageId: 'unrelated-page', worktreeId, closedAt: 43 }
        ],
        'environment-1': [{ browserPageId: 'destination-page', worktreeId, closedAt: 44 }]
      }
    })
    const result = collectOrcadMigrationSourceClientState(
      current,
      source,
      catalog,
      'environment-1',
      current.workspaceSession
    )

    expect(result.blockedCount).toBe(1)
    expect(result.payload?.clientHostedBrowserCloseIntents).toEqual([
      {
        sourceEnvironmentId: 'old-environment',
        browserPageId: 'page-1',
        worktreeId: 'repo-1::/srv/worktree',
        closedAt: 42
      }
    ])
  })
})
