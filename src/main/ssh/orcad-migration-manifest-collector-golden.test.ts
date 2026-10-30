import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../shared/constants'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { SshTarget } from '../../shared/ssh-types'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { collectOrcadMigrationSourceDormantState } from '../persistence/migrating-orcad-catalog/orcad-source-dormant-state'
import {
  DORMANT_AUTOMATION,
  DORMANT_AUTOMATION_RUN,
  FOLDER_WORKSPACE,
  PROJECT_GROUP,
  REPOSITORY
} from '../persistence/migrating-orcad-catalog/persistence-orcad-migration-catalog-fixture'
import { createOrcadMigrationManifest } from './orcad-migration-manifest-export'

// Pins the SSH export through the real dormant-state collectors, so generalizing their source scope
// cannot change one byte an SSH destination signs and verifies.
const TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 3
}
const HOST = 'ssh:ssh-prod'
const WORKTREE = 'repo-1::/srv/repo-1-feature'
const OTHER_WORKTREE = 'desktop-repo::/home/user/repo'

function tab(id: string, worktreeId = WORKTREE): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    startupCwd: '/srv/repo-1-feature/src'
  }
}

function meta(hostId?: ExecutionHostId) {
  return {
    displayName: 'Feature',
    comment: 'Keep',
    isUnread: false,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isPinned: true,
    sortOrder: 2,
    lastActivityAt: 3,
    ...(hostId ? { hostId } : {})
  }
}

function baseState(): PersistedState {
  const state = getDefaultPersistedState('/home/user')
  state.sshTargets = [
    { ...TARGET, portForwards: [{ localPort: 3000, remoteHost: 'localhost', remotePort: 3000 }] }
  ]
  state.projectGroups = [PROJECT_GROUP]
  state.repos = [
    REPOSITORY,
    {
      id: 'desktop-repo',
      path: '/home/user/repo',
      displayName: 'Desktop',
      badgeColor: '#737373',
      addedAt: 1
    }
  ]
  state.folderWorkspaces = [FOLDER_WORKSPACE]
  return state
}

function richState(): PersistedState {
  const state = baseState()
  state.worktreeMeta[WORKTREE] = meta(HOST)
  state.worktreeLineageById[WORKTREE] = {
    worktreeId: WORKTREE,
    worktreeInstanceId: 'child',
    parentWorktreeId: 'repo-1::/srv/repo-1',
    parentWorktreeInstanceId: 'parent',
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  }
  state.sparsePresetsByRepo['repo-1'] = [
    {
      id: 'preset',
      repoId: 'repo-1',
      name: 'Src',
      directories: ['src'],
      createdAt: 1,
      updatedAt: 2
    }
  ]
  state.automations = [
    {
      ...DORMANT_AUTOMATION,
      runContext: { ...DORMANT_AUTOMATION.runContext!, hostId: HOST },
      executionTargetType: 'ssh',
      executionTargetId: TARGET.id,
      executionTargetGeneration: TARGET.generation,
      schedulerOwner: 'ssh_bridge'
    }
  ]
  state.automationRuns = [
    {
      ...DORMANT_AUTOMATION_RUN,
      runContext: { ...DORMANT_AUTOMATION_RUN.runContext!, hostId: HOST }
    }
  ]
  const host = getDefaultWorkspaceSession()
  host.activeRepoId = 'repo-1'
  host.activeWorktreeId = WORKTREE
  host.tabsByWorktree = { [WORKTREE]: [tab('shell'), tab('build')] }
  host.terminalLayoutsByTabId = {
    shell: {
      root: { type: 'leaf', leafId: 'leaf' },
      activeLeafId: 'leaf',
      expandedLeafId: null,
      buffersByLeafId: { leaf: 'saved output' }
    }
  }
  host.openFilesByWorktree = {
    [WORKTREE]: [
      {
        filePath: '/srv/repo-1-feature/README.md',
        relativePath: 'README.md',
        worktreeId: WORKTREE,
        language: 'markdown'
      }
    ]
  }
  state.workspaceSessionsByHostId = { [HOST]: host }
  state.workspaceSession.tabsByWorktree = { [OTHER_WORKTREE]: [tab('desktop', OTHER_WORKTREE)] }
  return state
}

function sharedRepoState(): PersistedState {
  const state = richState()
  // The same repo id registered on this desktop too: legacy unqualified keys stay put.
  state.repos.push({
    ...REPOSITORY,
    connectionId: undefined,
    executionHostId: 'local',
    path: '/home/user/repo-1'
  })
  state.worktreeMeta['repo-1::/srv/repo-1-unqualified'] = meta()
  const child = worktreeWorkspaceKey(WORKTREE)
  state.workspaceLineageByChildKey[child] = {
    childWorkspaceKey: child,
    childInstanceId: 'child',
    parentWorkspaceKey: 'folder:folder-1',
    parentInstanceId: null,
    origin: 'cli',
    capture: { source: 'cwd-context', confidence: 'inferred' },
    createdAt: 1
  }
  return state
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
    {
      migrationId: 'migration-collector-golden',
      now: () => new Date('2026-10-01T00:00:00.000Z'),
      destinationEnvironmentId: 'env-golden'
    }
  )
}

// Pinned on main before the dormant collectors learned a local-WSL scope.
const GOLDEN = {
  base: '895d1122c5447c38dce29c913f499836eaf6493746f71106437a15193de4dfdc',
  rich: '432ba03f63495003e0b2d7ed12d5a7d767e4949b41d65f89908bfe94d67b935e',
  shared: '690c62cb37b1aaab67184a9de2d65a548a9ed84d6f72b39bb758161a781ae165'
}

describe('SSH migration manifest through the real collectors', () => {
  it.each([
    ['base', baseState],
    ['rich', richState],
    ['shared', sharedRepoState]
  ] as const)('keeps the %s profile digest byte-identical', (name, build) => {
    expect(exportState(build()).manifestSha256).toBe(GOLDEN[name])
  })

  it('exercises every collector the rich profile feeds', () => {
    const dormant = exportState(richState()).payload.dormantState
    expect({
      worktreeMeta: dormant?.worktreeMeta.length,
      worktreeLineage: dormant?.worktreeLineage.length,
      sparsePresets: dormant?.sparsePresets.length,
      automations: dormant?.automations?.length,
      automationRuns: dormant?.automationRuns?.length,
      sessionTabs: Object.keys(dormant?.workspaceSession?.tabsByWorktree ?? {}).length,
      savedPortForwards: dormant?.clientState?.savedPortForwards?.length
    }).toMatchSnapshot()
  })

  it('keeps the blocked counts of the rich profiles unchanged', () => {
    for (const build of [richState, sharedRepoState]) {
      const state = build()
      const manifest = exportState(state)
      const inspection = collectOrcadMigrationSourceDormantState(
        state,
        manifest.source,
        manifest.payload,
        undefined,
        'env-golden'
      )
      expect({
        blockedCounts: inspection.blockedCounts,
        blockedSessionItems: inspection.blockedSessionItems,
        leftBehindItems: inspection.leftBehindItems
      }).toMatchSnapshot()
    }
  })
})
