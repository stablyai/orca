import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  type OrcadMigrationManifest
} from '../../../shared/orcad-migration-manifest'
import type { Repo } from '../../../shared/repo-types'
import type { SshTarget } from '../../../shared/ssh-types'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { collectOrcadMigrationUntransferredDependencyCensus } from './orcad-source-dependency-census'

const TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 8
}

const REPO: Repo = {
  id: 'repo-1',
  path: '/srv/repo',
  displayName: 'Repository',
  badgeColor: '#737373',
  addedAt: 1,
  connectionId: TARGET.id,
  executionHostId: `ssh:${TARGET.id}`,
  projectGroupId: 'group-1'
}

const FOLDER: FolderWorkspace = {
  id: 'folder-1',
  projectGroupId: 'group-1',
  name: 'Folder',
  folderPath: '/srv/folder',
  connectionId: TARGET.id,
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1
}

const MANIFEST: OrcadMigrationManifest = {
  version: ORCAD_MIGRATION_MANIFEST_VERSION,
  migrationId: 'migration-1',
  createdAt: '2026-08-30T12:00:00.000Z',
  source: {
    sshTargetId: TARGET.id,
    sshTargetGeneration: TARGET.generation ?? null,
    targetLabel: TARGET.label
  },
  payload: {
    repositories: [REPO],
    projectGroups: [],
    folderWorkspaces: [FOLDER]
  },
  manifestSha256: 'a'.repeat(64)
}

describe('orcad migration source dependency census', () => {
  it('ignores client focus on another host copied into the source host partition', () => {
    const state = getDefaultPersistedState('/home/test')
    state.sshTargets = [TARGET]
    state.repos = [REPO]
    state.folderWorkspaces = [FOLDER]
    const localWorktreeId = 'local-repo::/home/test/local'
    state.workspaceSession = { ...state.workspaceSession, activeWorktreeId: localWorktreeId }
    state.workspaceSessionsByHostId = {
      [`ssh:${TARGET.id}`]: {
        ...state.workspaceSession,
        activeWorktreeId: localWorktreeId,
        activeWorkspaceKey: worktreeWorkspaceKey(localWorktreeId)
      }
    }

    expect(collectOrcadMigrationUntransferredDependencyCensus(state, MANIFEST)).toMatchObject({
      totalCount: 0
    })
  })

  it('allows a static catalog with no unrepresented dependent state', () => {
    const state = getDefaultPersistedState('/home/test')
    state.sshTargets = [TARGET]
    state.repos = [REPO]
    state.folderWorkspaces = [FOLDER]

    expect(collectOrcadMigrationUntransferredDependencyCensus(state, MANIFEST)).toMatchObject({
      totalCount: 0
    })
  })

  it('keeps another SSH target and its host partition outside the source fence', () => {
    const state = getDefaultPersistedState('/home/test')
    state.sshTargets = [TARGET, { ...TARGET, id: 'ssh-other', generation: 9 }]
    state.workspaceSessionsByHostId = {
      'ssh:ssh-other': {
        ...state.workspaceSession,
        tabsByWorktree: {
          'other-repo::/srv/worktree': [
            {
              id: 'tab-other',
              ptyId: 'pty-other',
              worktreeId: 'other-repo::/srv/worktree',
              title: 'Other',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        }
      }
    }

    expect(collectOrcadMigrationUntransferredDependencyCensus(state, MANIFEST).totalCount).toBe(0)
  })

  it('counts a lease that is not terminated as live terminal work', () => {
    const state = getDefaultPersistedState('/home/test')
    state.sshTargets = [TARGET]
    state.repos = [REPO]
    state.sshRemotePtyLeases = [
      { targetId: TARGET.id, ptyId: 'pty-1', state: 'detached', createdAt: 1, updatedAt: 1 },
      { targetId: TARGET.id, ptyId: 'pty-2', state: 'terminated', createdAt: 1, updatedAt: 2 }
    ]

    expect(collectOrcadMigrationUntransferredDependencyCensus(state, MANIFEST)).toMatchObject({
      totalCount: 1,
      counts: { 'terminal-lease': 1 }
    })
  })
})
