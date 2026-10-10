import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import type { SshTarget } from '../../shared/ssh-types'
import { computeOrcadMigrationManifestSha256 } from '../orcad/orcad-migration-manifest-digest'
import { emptyDormantPayload } from '../persistence/migrating-orcad-catalog/orcad-source-dormant-state'
import { createOrcadMigrationManifest } from './orcad-migration-manifest-export'

const TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 7
}

function repo(id: string, connectionId: string, projectGroupId?: string): Repo {
  return {
    id,
    path: `/srv/${id}`,
    displayName: id,
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    connectionId,
    ...(projectGroupId ? { projectGroupId } : {})
  }
}

function group(
  id: string,
  connectionId: string | null,
  parentGroupId: string | null = null
): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: `/srv/${id}`,
    connectionId,
    parentGroupId,
    createdFrom: 'manual',
    tabOrder: 1,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function folder(id: string, projectGroupId: string, connectionId?: string): FolderWorkspace {
  return {
    id,
    projectGroupId,
    name: id,
    folderPath: `/srv/${id}`,
    ...(connectionId ? { connectionId } : {}),
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('orcad migration manifest export', () => {
  it('exports only the target catalog plus referenced group ancestry', () => {
    const groups = [
      group('parent', null),
      group('repo-group', 'ssh-prod', 'parent'),
      group('folder-group', 'ssh-prod'),
      group('other-group', 'ssh-other')
    ]
    const manifest = createOrcadMigrationManifest(
      {
        collectOrcadMigrationSourceDormantState: emptyDormantPayload,
        getRepos: () => [
          repo('repo-prod', 'ssh-prod', 'repo-group'),
          repo('repo-other', 'ssh-other')
        ],
        getProjectGroups: () => groups,
        getFolderWorkspaces: () => [
          folder('folder-inherited', 'folder-group'),
          folder('folder-explicit', 'folder-group', 'ssh-prod'),
          folder('folder-other', 'other-group', 'ssh-other')
        ]
      },
      TARGET,
      { migrationId: 'migration-1', now: () => new Date('2026-08-30T12:00:00.000Z') }
    )

    expect(manifest.payload.repositories.map((entry) => entry.id)).toEqual(['repo-prod'])
    expect(manifest.payload.projectGroups.map((entry) => entry.id)).toEqual([
      'parent',
      'repo-group',
      'folder-group'
    ])
    expect(manifest.payload.folderWorkspaces.map((entry) => entry.id)).toEqual([
      'folder-inherited',
      'folder-explicit'
    ])
    expect(manifest.source).toEqual({
      sshTargetId: 'ssh-prod',
      sshTargetGeneration: 7,
      targetLabel: 'Production'
    })
    const { manifestSha256, ...unsigned } = manifest
    expect(manifestSha256).toBe(computeOrcadMigrationManifestSha256(unsigned))
  })

  it('records a null generation for a legacy registration without mutating it', () => {
    const target = { ...TARGET, generation: undefined }
    const manifest = createOrcadMigrationManifest(
      {
        collectOrcadMigrationSourceDormantState: emptyDormantPayload,
        getRepos: () => [],
        getProjectGroups: () => [],
        getFolderWorkspaces: () => []
      },
      target,
      { migrationId: 'migration-legacy', now: () => new Date('2026-08-30T12:00:00.000Z') }
    )

    expect(manifest.source.sshTargetGeneration).toBeNull()
    expect(target.generation).toBeUndefined()
  })

  it('includes a session-only dormant payload', () => {
    const dormant = emptyDormantPayload()
    dormant.workspaceSession = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        'repo-prod::/srv/worktree': [
          {
            id: 'tab-dormant',
            ptyId: null,
            worktreeId: 'repo-prod::/srv/worktree',
            title: 'Dormant',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    }
    const manifest = createOrcadMigrationManifest(
      {
        collectOrcadMigrationSourceDormantState: () => dormant,
        getRepos: () => [repo('repo-prod', TARGET.id)],
        getProjectGroups: () => [],
        getFolderWorkspaces: () => []
      },
      TARGET,
      { migrationId: 'migration-session-only' }
    )

    expect(manifest.payload.dormantState?.workspaceSession?.tabsByWorktree).toHaveProperty(
      'repo-prod::/srv/worktree'
    )
  })
})
