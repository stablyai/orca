import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  parseOrcadMigrationManifest,
  type OrcadMigrationManifest
} from '../../../shared/orcad-migration-manifest'
import { computeOrcadMigrationManifestSha256 } from '../../orcad/orcad-migration-manifest-digest'
import {
  prepareOrcadTerminalLayoutAdmission,
  type OrcadTerminalLayoutAdmission
} from './orcad-terminal-layout-admission'

export function sealAdmissionManifest(value: OrcadMigrationManifest): OrcadMigrationManifest {
  const { manifestSha256: _digest, ...parsed } = parseOrcadMigrationManifest(value)
  return { ...parsed, manifestSha256: computeOrcadMigrationManifestSha256(parsed) }
}

export function terminalLayoutAdmissionFixture(
  kind: 'folder' | 'worktree' = 'worktree',
  targetId = 'ssh-1'
) {
  const owner = kind === 'folder' ? 'folder:folder-1' : 'repo-1::/srv/worktree'
  const workspaceKey =
    kind === 'folder' ? ('folder:folder-1' as const) : ('worktree:repo-1::/srv/worktree' as const)
  const leaves = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
  const session = getDefaultWorkspaceSession()
  session.tabsByWorktree[owner] = [
    {
      id: 'tab-1',
      worktreeId: owner,
      ptyId: null,
      title: 'Preserved tab',
      customTitle: 'My tab',
      color: null,
      sortOrder: 1,
      createdAt: 1
    }
  ]
  session.terminalLayoutsByTabId['tab-1'] = {
    root: {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.3,
      first: { type: 'leaf', leafId: leaves[0] },
      second: { type: 'leaf', leafId: leaves[1] }
    },
    activeLeafId: leaves[1],
    expandedLeafId: null,
    titlesByLeafId: { [leaves[0]]: 'Build', [leaves[1]]: 'Logs' }
  }
  const manifest = sealAdmissionManifest({
    version: 1,
    migrationId: 'migration-1',
    createdAt: '2026-09-06T00:00:00.000Z',
    manifestSha256: '0'.repeat(64),
    source: { sshTargetId: targetId, sshTargetGeneration: 1, targetLabel: 'Host' },
    payload: {
      repositories: [
        { id: 'repo-1', path: '/srv/repo', displayName: 'Repo', badgeColor: '#737373', addedAt: 1 }
      ],
      projectGroups: [
        {
          id: 'group-1',
          name: 'Group',
          parentPath: '/srv',
          connectionId: null,
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 1,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      folderWorkspaces:
        kind === 'folder'
          ? [
              {
                id: 'folder-1',
                projectGroupId: 'group-1',
                name: 'Folder',
                folderPath: '/srv/folder',
                connectionId: null,
                linkedTask: null,
                linkedTaskSourceContext: null,
                comment: '',
                isArchived: false,
                isUnread: false,
                isPinned: false,
                sortOrder: 1,
                lastActivityAt: 1,
                createdAt: 1,
                updatedAt: 1
              }
            ]
          : [],
      dormantState: {
        version: 1,
        worktreeMeta: [],
        worktreeLineage: [],
        workspaceLineage: [],
        sparsePresets: [],
        retiredWorktreeNames: [],
        retiredWorktreeNamespaces: [],
        workspaceSession: session
      }
    }
  })
  const bindings: OrcadTerminalLayoutAdmission['bindings'] = leaves.map((leafId, i) => ({
    identity: {
      bridgeId: `bridge-${i}`,
      terminalId: `terminal-${i}`,
      incarnationId: `incarnation-${i}`,
      ownerLease: `lease-${i}`,
      sourceOwnerGeneration: 1,
      destinationRuntimeId: 'runtime-1'
    },
    surfaceBinding: {
      executionHostId: 'local',
      workspaceKey,
      tabId: 'tab-1',
      leafId,
      ptyId: `terminal-${i}`
    }
  }))
  const state = getDefaultPersistedState('/tmp/orcad-admission-test')
  state.orcadMigrationStagedCatalogs = [
    { version: 1, manifest: structuredClone(manifest), stagedAt: manifest.createdAt }
  ]
  const admission = prepareOrcadTerminalLayoutAdmission(manifest, bindings, state)
  return { owner, manifest, bindings, state, admission }
}
