import { describe, expect, it } from 'vitest'
import type { OrcadMigrationCatalogPayload } from '../../../../../shared/orcad-migration/orcad-migration-manifest'
import type { PersistedState } from '../../../../../shared/persisted-state-types'
import {
  getDefaultPersistedState,
  getDefaultWorkspaceSession
} from '../../../../../shared/constants'
import type { BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import {
  CLIENT_HOSTED_BROWSER_PAGE_RECORD_VERSION,
  type PersistedClientHostedBrowserPage
} from '../../../../../shared/workspace-session/client-hosted-browser-page-record'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
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
  it('leaves behind a mobile selection that points at a group outside the migrated owner', () => {
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
    expect(result.blockedCount).toBe(0)
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

    expect(result.blockedCount).toBe(0)
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
