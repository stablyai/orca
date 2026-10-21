import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { assertOrcadMigrationManifestDigest } from '../../orcad/orcad-migration-manifest-digest'
import {
  DORMANT_AUTOMATION,
  DORMANT_AUTOMATION_RUN
} from '../../persistence-orcad-migration-catalog-fixture'
import { createOrcadMigrationSourceScope } from '../migrating-orcad-catalog/orcad-source-scope'
import { collectOrcadMigrationSourceDormantState } from '../migrating-orcad-catalog/orcad-source-dormant-state'
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
const MAIN_WORKTREE = `app::${UNC_REPO}`
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
  it('signs a manifest whose source is exactly the request, with Linux paths', () => {
    const result = exportWslMoveManifest(storeFor(sourceState()), REQUEST)
    expect(result.blockers).toEqual([])
    expect(result.manifest.source).toEqual({
      kind: 'local-wsl',
      distro: DISTRO,
      distroGuid: '{guid}',
      scopeRepoIds: ['app'],
      scopeFolderWorkspaceIds: [],
      generation: 2
    })
    expect(result.manifest.destinationEnvironmentId).toBe('wsl:Ubuntu')
    expect(result.manifest.payload.repositories.map((row) => row.path)).toEqual(['/home/me/app'])
    expect(() => assertOrcadMigrationManifestDigest(result.manifest)).not.toThrow()
  })

  it('is deterministic for one state and request', () => {
    const state = sourceState()
    expect(exportWslMoveManifest(storeFor(state), REQUEST).manifest.manifestSha256).toBe(
      exportWslMoveManifest(storeFor(structuredClone(state)), REQUEST).manifest.manifestSha256
    )
  })

  it("carries the moved project's dormant state and none of another local project's", () => {
    const dormant = exportWslMoveManifest(storeFor(sourceState()), REQUEST).manifest.payload
      .dormantState
    const linuxWorktree = 'app::/home/me/app-feature'
    expect(dormant?.worktreeMeta.map((row) => row.worktreeId)).toEqual([linuxWorktree])
    expect(Object.keys(dormant?.workspaceSession?.tabsByWorktree ?? {})).toEqual([linuxWorktree])
    expect(dormant?.automations?.map((row) => row.id)).toEqual(['automation-app'])
    expect(dormant?.automations?.[0]).toMatchObject({
      enabled: false,
      schedulerOwner: 'remote_host_service',
      executionTargetType: 'local'
    })
    expect(dormant?.automationRuns?.map((row) => row.automationId)).toEqual(['automation-app'])
  })

  it('re-enables on the host what this desktop ran enabled', () => {
    expect(exportWslMoveManifest(storeFor(sourceState()), REQUEST).automationsToReenable).toEqual([
      'automation-app'
    ])
  })

  it('names the workspaces to quiesce and where each worktree lands', () => {
    const result = exportWslMoveManifest(storeFor(sourceState()), REQUEST)
    expect(result.workspaceKeys).toEqual([MAIN_WORKTREE, WORKTREE].sort())
    expect(result.workspaceIds).toEqual(result.workspaceKeys)
    expect(result.worktrees).toContainEqual({
      sourceWorktreeId: WORKTREE,
      destinationWorktreeId: 'app::/home/me/app-feature'
    })
  })

  it('never takes another host’s row of the same repo id', () => {
    const state = sourceState()
    state.repos.push(repo('app', '/srv/app', { connectionId: 'box', executionHostId: 'ssh:box' }))
    const result = exportWslMoveManifest(storeFor(state), REQUEST)
    expect(result.manifest.payload.repositories.map((row) => row.path)).toEqual(['/home/me/app'])
  })

  it("never signs this desktop's retained mark into the manifest", () => {
    const state = sourceState()
    const mark = { migrationId: 'move-0', environmentId: 'wsl:Ubuntu' }
    state.repos = state.repos.map((row) =>
      row.id === 'app' ? { ...row, orcadRetained: mark } : row
    )
    const store = storeFor(state)
    const { manifest } = exportWslMoveManifest(store, REQUEST)
    expect(manifest.payload.repositories.map((row) => row.orcadRetained)).toEqual([undefined])
    // The stored row keeps its mark.
    expect(store.getRepos().find((row) => row.id === 'app')?.orcadRetained).toEqual(mark)
  })

  it('refuses with a reason instead of dropping state the move cannot carry', () => {
    const state = sourceState()
    const record: SleepingAgentSessionRecord = {
      paneKey: 'feature-shell:missing-leaf',
      tabId: 'feature-shell',
      worktreeId: WORKTREE,
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'session-1' },
      prompt: 'Saved prompt',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      connectionId: null,
      origin: 'quit'
    }
    state.workspaceSession.terminalLayoutsByTabId = {
      'feature-shell': {
        root: { type: 'leaf', leafId: 'other' },
        activeLeafId: 'other',
        expandedLeafId: null
      }
    }
    state.workspaceSession.sleepingAgentSessionsByPaneKey = { [record.paneKey]: record }
    expect(exportWslMoveManifest(storeFor(state), REQUEST).blockers.length).toBeGreaterThan(0)
  })

  it('refuses to sign a scope naming a project that is no longer here', () => {
    expect(() =>
      exportWslMoveManifest(storeFor(sourceState()), { ...REQUEST, repoIds: ['app', 'gone'] })
    ).toThrow(WslMoveScopeChangedError)
  })

  it('still keeps the SSH conversion steps from accepting a WSL manifest', () => {
    const { manifest } = exportWslMoveManifest(storeFor(sourceState()), REQUEST)
    expect(() =>
      createOrcadMigrationSourceScope({
        source: manifest.source,
        catalog: manifest.payload,
        repos: []
      })
    ).toThrow('orcad_migration_source_not_ssh')
  })
})
