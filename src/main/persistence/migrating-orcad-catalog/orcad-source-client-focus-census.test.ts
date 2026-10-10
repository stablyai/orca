import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  type OrcadMigrationManifest
} from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import type { SshTarget } from '../../../shared/ssh-types'
import type { Tab } from '../../../shared/tab-types'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { collectOrcadMigrationUntransferredDependencyCensus } from './orcad-source-dependency-census'
import { collectOrcadMigrationSourceDormantState } from './orcad-source-dormant-state'

const TARGET: SshTarget = { id: 'ssh-prod', label: 'Prod', host: 'prod', port: 22, username: 'u' }
const SSH_HOST = `ssh:${TARGET.id}` as const
const REPO: Repo = {
  id: 'repo-1',
  path: '/srv/repo',
  displayName: 'Repository',
  badgeColor: '#737373',
  addedAt: 1,
  connectionId: TARGET.id,
  executionHostId: SSH_HOST
}
const WORKTREE = `${REPO.id}::/srv/repo`

function manifest(destinationEnvironmentId?: string): OrcadMigrationManifest {
  return {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: 'migration-1',
    createdAt: '2026-10-03T12:00:00.000Z',
    source: { sshTargetId: TARGET.id, sshTargetGeneration: null, targetLabel: TARGET.label },
    payload: { repositories: [REPO], projectGroups: [], folderWorkspaces: [] },
    ...(destinationEnvironmentId ? { destinationEnvironmentId } : {}),
    manifestSha256: 'a'.repeat(64)
  }
}

function editorTab(executionHostId?: ExecutionHostId): Tab {
  return {
    id: 'tab-1',
    entityId: '/srv/repo/README.md',
    groupId: 'group-1',
    worktreeId: WORKTREE,
    ...(executionHostId ? { executionHostId } : {}),
    contentType: 'editor',
    label: 'README.md',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function sourceState(): PersistedState {
  const state = getDefaultPersistedState('/home/test')
  state.sshTargets = [TARGET]
  state.repos = [REPO]
  return state
}

function focusLocalOnSourceWorktree(state: PersistedState): void {
  state.workspaceSession = {
    ...state.workspaceSession,
    activeRepoId: REPO.id,
    activeWorktreeId: WORKTREE,
    activeWorkspaceKey: worktreeWorkspaceKey(WORKTREE),
    activeWorkspaceExecutionHostId: SSH_HOST,
    activeTabId: 'tab-1'
  }
}

const sessionCount = (state: PersistedState): number =>
  collectOrcadMigrationUntransferredDependencyCensus(state, manifest('env-1')).counts[
    'workspace-session'
  ]

describe('orcad migration census and client focus', () => {
  it('never blocks a move on client focus aimed at a migrating worktree', () => {
    const state = sourceState()
    focusLocalOnSourceWorktree(state)

    expect(sessionCount(state)).toBe(0)
  })

  it('passes a v1.4.218 profile quit while focused on the source worktree', () => {
    // v1.4.218 copied the global focus fields into 'local' and into every host partition it wrote.
    const state = sourceState()
    focusLocalOnSourceWorktree(state)
    const focusCopy = {
      ...state.workspaceSession,
      unifiedTabs: {},
      tabsByWorktree: {}
    }
    state.workspaceSessionsByHostId = {
      [SSH_HOST]: { ...focusCopy, unifiedTabs: { [WORKTREE]: [editorTab('local')] } },
      'ssh:other-a': { ...focusCopy },
      'ssh:other-b': { ...focusCopy }
    }
    expect(sessionCount(state)).toBe(0)
  })

  it('carries no client focus into the destination session', () => {
    const state = sourceState()
    focusLocalOnSourceWorktree(state)
    state.workspaceSession.unifiedTabs = { [WORKTREE]: [editorTab(SSH_HOST)] }

    const session = collectOrcadMigrationSourceDormantState(state, manifest().source, {
      repositories: [REPO],
      projectGroups: [],
      folderWorkspaces: []
    }).payload.workspaceSession

    expect(session?.unifiedTabs?.[WORKTREE]).toHaveLength(1)
    expect(session?.activeWorktreeId ?? null).toBeNull()
    expect(session?.activeWorkspaceKey ?? null).toBeNull()
  })

  it("counts a 'local'-stamped tab in a migrating SSH worktree as the SSH host's", () => {
    const local = sourceState()
    local.workspaceSession.unifiedTabs = { [WORKTREE]: [editorTab('local')] }
    const partitioned = sourceState()
    partitioned.workspaceSessionsByHostId = {
      [SSH_HOST]: {
        ...partitioned.workspaceSession,
        unifiedTabs: { [WORKTREE]: [editorTab('local')] }
      }
    }

    expect(sessionCount(local)).toBe(0)
    expect(sessionCount(partitioned)).toBe(0)
  })

  it('still blocks a tab another host owns inside a migrating worktree', () => {
    const state = sourceState()
    state.workspaceSession.unifiedTabs = { [WORKTREE]: [editorTab('ssh:other')] }

    expect(sessionCount(state)).toBe(1)
  })
})
