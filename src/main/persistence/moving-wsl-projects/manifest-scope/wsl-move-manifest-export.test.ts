import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../../shared/constants'

import type { PersistedState } from '../../../../shared/persisted-state-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'

import {
  DORMANT_AUTOMATION,
  DORMANT_AUTOMATION_RUN
} from '../../migrating-orcad-catalog/catalog-commit/persistence-orcad-migration-catalog-fixture'

import { collectOrcadMigrationSourceDormantState } from '../../migrating-orcad-catalog/source/dormancy/orcad-source-dormant-state'
import {
  exportWslMoveManifest,
  WslMoveScopeChangedError,
  type WslMoveManifestExportRequest,
  type WslMoveManifestExportStore
} from './wsl-move-manifest-export'

const DISTRO = 'Ubuntu'
const UNC_REPO = '\\\\wsl.localhost\\Ubuntu\\home\\me\\app'
const UNC_WORKTREE = '\\\\wsl.localhost\\Ubuntu\\home\\me\\app-feature'
const WORKTREE = `app::${UNC_WORKTREE}`
const OTHER_WORKTREE = 'win::C:\\code\\win'

function repo(id: string, path: string, extra: Partial<Repo> = {}): Repo {
  return { id, path, displayName: id, badgeColor: '#737373', addedAt: 1, ...extra }
}

function tab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    startupCwd: worktreeId.split('::')[1]
  }
}

function sourceState(): PersistedState {
  const state = getDefaultPersistedState('C:\\Users\\me')
  state.repos = [
    repo('app', UNC_REPO),
    repo('win', 'C:\\code\\win'),
    repo('elsewhere', '\\\\wsl.localhost\\Debian\\home\\me\\other')
  ]
  state.worktreeMeta[WORKTREE] = {
    displayName: 'Feature',
    comment: 'keep',
    isUnread: false,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isPinned: true,
    sortOrder: 1,
    lastActivityAt: 2
  }
  state.worktreeMeta[OTHER_WORKTREE] = { ...state.worktreeMeta[WORKTREE], displayName: 'Windows' }
  state.automations = [
    {
      ...DORMANT_AUTOMATION,
      id: 'automation-app',
      enabled: true,
      projectId: 'app',
      runContext: {
        ...DORMANT_AUTOMATION.runContext!,
        repoId: 'app',
        projectHostSetupId: 'app',
        path: UNC_REPO
      },
      executionTargetType: 'local',
      executionTargetId: 'local',
      schedulerOwner: 'local_host_service'
    },
    {
      ...DORMANT_AUTOMATION,
      id: 'automation-win',
      enabled: true,
      projectId: 'win',
      runContext: {
        ...DORMANT_AUTOMATION.runContext!,
        repoId: 'win',
        projectHostSetupId: 'win',
        path: 'C:\\code\\win'
      },
      executionTargetType: 'local',
      executionTargetId: 'local',
      schedulerOwner: 'local_host_service'
    }
  ]
  state.automationRuns = [
    {
      ...DORMANT_AUTOMATION_RUN,
      automationId: 'automation-app',
      runContext: state.automations[0]!.runContext
    }
  ]
  state.workspaceSession = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE]: [tab('feature-shell', WORKTREE)],
      [OTHER_WORKTREE]: [tab('windows-shell', OTHER_WORKTREE)]
    }
  }
  return state
}

function storeFor(state: PersistedState): WslMoveManifestExportStore {
  return {
    getRepos: () => state.repos,
    getFolderWorkspaces: () => state.folderWorkspaces,
    getProjectGroups: () => state.projectGroups,
    inspectOrcadMigrationSourceDormantState: (source, catalog, destination) =>
      collectOrcadMigrationSourceDormantState(state, source, catalog, undefined, destination)
  }
}

const REQUEST: WslMoveManifestExportRequest = {
  migrationId: 'move-1',
  now: () => new Date('2026-10-20T00:00:00.000Z'),
  distro: DISTRO,
  distroGuid: '{guid}',
  destinationEnvironmentId: 'wsl:Ubuntu',
  generation: 2,
  repoIds: ['app'],
  folderWorkspaceIds: []
}

describe('exportWslMoveManifest', () => {
  it('carries no desktop PTY binding, so the moved pane reads its history from the host', () => {
    // The host's session kept the desktop's PTY ids, so the client took each pane
    // for a live terminal, skipped the scrollback read, and opened a fresh prompt.
    const state = sourceState()
    const leaf = '11111111-1111-4111-8111-111111111111'
    const tab = state.workspaceSession.tabsByWorktree[WORKTREE]![0]!
    state.workspaceSession.tabsByWorktree[WORKTREE] = [{ ...tab, ptyId: `${WORKTREE}@@81c7100a` }]
    state.workspaceSession.terminalLayoutsByTabId = {
      [tab.id]: {
        root: { type: 'leaf', leafId: leaf },
        activeLeafId: leaf,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leaf]: `${WORKTREE}@@81c7100a` },
        buffersByLeafId: { [leaf]: 'history' }
      }
    }
    const { manifest } = exportWslMoveManifest(storeFor(state), REQUEST)
    const session = manifest.payload.dormantState?.workspaceSession
    const layout = Object.values(session?.terminalLayoutsByTabId ?? {})[0]
    expect(layout?.scrollbackRefsByLeafId?.[leaf]).toBeTruthy()
    expect(layout).not.toHaveProperty('ptyIdsByLeafId')
    expect(Object.values(session?.tabsByWorktree ?? {}).flat()[0]?.ptyId).toBeNull()
  })

  it('refuses to sign a scope naming a project that is no longer here', () => {
    expect(() =>
      exportWslMoveManifest(storeFor(sourceState()), { ...REQUEST, repoIds: ['app', 'gone'] })
    ).toThrow(WslMoveScopeChangedError)
  })
})
