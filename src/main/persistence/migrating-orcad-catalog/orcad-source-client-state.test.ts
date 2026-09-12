import { describe, expect, it } from 'vitest'
import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationManifest
} from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { collectOrcadMigrationSourceClientState } from './orcad-source-client-state'
import { retireOrcadMigrationSourceDormantState } from './orcad-source-dormant-state'

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
  return {
    sshTargets: [{ id: source.sshTargetId, label: source.targetLabel, portForwards: [] }],
    mobileClientTabSelectionsByDeviceId: {},
    ui: {
      lastActiveRepoId: null,
      lastActiveWorktreeId: null,
      filterRepoIds: [],
      showDotfilesByWorktree: {},
      setupScriptPromptDismissedRepoIds: [],
      manualRepoOrder: [],
      workspaceHostScope: undefined,
      visibleWorkspaceHostIds: null,
      workspaceHostOrder: [],
      automationHostFilter: { kind: 'all' },
      acknowledgedAgentsByPaneKey: {}
    }
  } as unknown as PersistedState
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
    const session = {
      tabsByWorktree: {
        'ssh:target-1|repo-1::/srv/worktree': [{ id: 'tab-1' }]
      },
      tabGroups: {}
    } as unknown as WorkspaceSessionState

    const result = collectOrcadMigrationSourceClientState(
      current,
      source,
      catalog,
      'environment-1',
      session
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
    const session = {
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
    } as unknown as WorkspaceSessionState

    const result = collectOrcadMigrationSourceClientState(
      current,
      source,
      catalog,
      'environment-1',
      session
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
    const session = {
      tabsByWorktree: {
        [sourceOwner]: [{ id: 'tab-source' }]
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
    } as unknown as WorkspaceSessionState

    const result = collectOrcadMigrationSourceClientState(
      current,
      source,
      catalog,
      'environment-1',
      session
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
    current.workspaceSession = {
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      browserTabsByWorktree: {
        [worktreeId]: [{ id: 'browser-1', worktreeId }]
      },
      clientHostedBrowserPagesByWorktree: {
        [worktreeId]: [{ browserPageId: 'page-1', workspaceId: 'browser-1' }]
      },
      clientHostedBrowserCloseIntentsByEnvironment: {
        'old-environment': [
          { browserPageId: 'page-1', worktreeId, closedAt: 42 },
          { browserPageId: 'unrelated-page', worktreeId, closedAt: 43 }
        ],
        'environment-1': [{ browserPageId: 'destination-page', worktreeId, closedAt: 44 }]
      }
    } as unknown as WorkspaceSessionState
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

  it('rekeys captured close intents at source retirement and preserves destination debt', () => {
    const worktreeId = 'repo-1::/srv/worktree'
    const captured = {
      sourceEnvironmentId: 'old-environment',
      browserPageId: 'page-1',
      worktreeId,
      closedAt: 42
    }
    const current = {
      workspaceSession: {
        clientHostedBrowserCloseIntentsByEnvironment: {
          'old-environment': [
            { browserPageId: 'page-1', worktreeId, closedAt: 42 },
            { browserPageId: 'unrelated-page', worktreeId, closedAt: 43 }
          ],
          'environment-1': [{ browserPageId: 'destination-page', worktreeId, closedAt: 44 }]
        },
        tabsByWorktree: {},
        terminalLayoutsByTabId: {}
      },
      workspaceSessionsByHostId: {},
      mobileClientTabSelectionsByDeviceId: {},
      sshTargets: [],
      ui: state().ui
    } as unknown as PersistedState
    const manifest = {
      source,
      destinationEnvironmentId: 'environment-1',
      payload: {
        repositories: catalog.repositories,
        projectGroups: [],
        folderWorkspaces: [],
        dormantState: {
          version: 1,
          worktreeMeta: [],
          worktreeLineage: [],
          workspaceLineage: [],
          sparsePresets: [],
          retiredWorktreeNames: [],
          retiredWorktreeNamespaces: [],
          clientState: { clientHostedBrowserCloseIntents: [captured] }
        }
      }
    } as unknown as OrcadMigrationManifest

    retireOrcadMigrationSourceDormantState(current, manifest)

    expect(current.workspaceSession.clientHostedBrowserCloseIntentsByEnvironment).toEqual({
      'old-environment': [{ browserPageId: 'unrelated-page', worktreeId, closedAt: 43 }],
      'environment-1': [
        { browserPageId: 'destination-page', worktreeId, closedAt: 44 },
        { browserPageId: 'page-1', worktreeId, closedAt: 42 }
      ]
    })
  })
})
