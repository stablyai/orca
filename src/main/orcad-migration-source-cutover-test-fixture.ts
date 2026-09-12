import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  type OrcadMigrationImportReceipt
} from '../shared/orcad-migration-manifest'
import type { SshTarget } from '../shared/ssh-types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../shared/workspace-scope'
import { createStore } from './persistence-test-harness'
import { getRemoteRetirementNamespaceKey } from './worktree-name-retirement'
import { createOrcadMigrationManifest } from './ssh/orcad-migration-manifest-export'

export const TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 8
}
export const DORMANT_LEAF_ID = '11111111-1111-4111-8111-111111111111'

export function setupSource(
  options: {
    dormantState?: boolean
    dormantSession?: boolean
    dormantAutomation?: boolean
    localAncestor?: boolean
  } = {}
) {
  const store = createStore()
  store.addSshTarget(TARGET)
  const localAncestor = options.localAncestor
    ? store.createProjectGroup({
        name: 'All projects',
        parentPath: '/projects',
        connectionId: null,
        createdFrom: 'manual'
      })
    : null
  const group = store.createProjectGroup({
    name: 'Production',
    parentPath: '/srv',
    connectionId: TARGET.id,
    parentGroupId: localAncestor?.id,
    createdFrom: 'manual'
  })
  store.addRepo({
    id: 'repo-1',
    path: '/srv/repo-1',
    displayName: 'Repository',
    badgeColor: '#737373',
    addedAt: 1,
    connectionId: TARGET.id,
    executionHostId: `ssh:${TARGET.id}`,
    projectGroupId: group.id
  })
  const folderWorkspace = store.createFolderWorkspace({
    projectGroupId: group.id,
    name: 'Folder',
    folderPath: '/srv/folder',
    connectionId: TARGET.id
  })
  const sourceNamespaceKey = options.dormantState
    ? addDormantSourceState(store, folderWorkspace.id)
    : null
  if (options.dormantSession) {
    addDormantSourceSession(store, folderWorkspace.id)
  }
  const dormantAutomationId = options.dormantAutomation ? addDormantAutomation(store) : null
  const manifest = createOrcadMigrationManifest(store, TARGET, {
    migrationId: 'migration-1',
    now: () => new Date('2026-08-30T12:00:00.000Z')
  })
  return { store, manifest, localAncestor, sourceNamespaceKey, dormantAutomationId }
}

export function addDormantAutomation(
  store: ReturnType<typeof createStore>,
  finalRun = true
): string {
  const created = store.createAutomation({
    name: 'Nightly checks',
    prompt: 'Run tests',
    agentId: 'codex',
    projectId: 'repo-1',
    workspaceMode: 'new_per_run',
    baseBranch: 'main',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: Date.now() - 60_000
  })
  const run = store.createAutomationRun(created, Date.now() - 30_000)
  if (finalRun) {
    store.updateAutomationRun({
      runId: run.id,
      status: 'completed',
      outputSnapshot: {
        format: 'plain_text',
        content: 'all green',
        capturedAt: Date.now(),
        truncated: false
      }
    })
  }
  const expectedOwner = store.automationOwnerPrecondition(created.id)
  if (!expectedOwner) {
    throw new Error('expected automation owner')
  }
  store.updateAutomation(created.id, { enabled: false }, { expectedOwner })
  return created.id
}

function addDormantSourceSession(
  store: ReturnType<typeof createStore>,
  folderWorkspaceId: string
): void {
  const worktreeId = 'repo-1::/srv/repo-1-worktree'
  const folderKey = folderWorkspaceKey(folderWorkspaceId)
  store.setWorkspaceSession(
    {
      ...store.getWorkspaceSession(`ssh:${TARGET.id}`),
      tabsByWorktree: {
        [worktreeId]: [
          {
            id: 'tab-dormant',
            ptyId: null,
            worktreeId,
            title: 'Dormant terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 7
          }
        ],
        [folderKey]: [
          {
            id: 'tab-folder-dormant',
            ptyId: null,
            worktreeId: folderKey,
            title: 'Dormant folder terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 8
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-dormant': {
          root: { type: 'leaf', leafId: DORMANT_LEAF_ID },
          activeLeafId: DORMANT_LEAF_ID,
          expandedLeafId: null,
          titlesByLeafId: { [DORMANT_LEAF_ID]: 'Investigating' }
        }
      },
      unifiedTabs: {
        [worktreeId]: [
          {
            id: 'tab-dormant',
            entityId: 'tab-dormant',
            groupId: 'group-dormant',
            worktreeId,
            executionHostId: `ssh:${TARGET.id}`,
            contentType: 'terminal',
            label: 'Dormant terminal',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 7
          }
        ]
      }
    },
    `ssh:${TARGET.id}`
  )
}

function addDormantSourceState(
  store: ReturnType<typeof createStore>,
  folderWorkspaceId: string
): string {
  const worktreeId = 'repo-1::/srv/repo-1-worktree'
  store.setWorktreeMeta(worktreeId, {
    instanceId: 'instance-1',
    displayName: 'Dormant worktree',
    comment: 'Preserve me',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: true,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 2,
    hostId: `ssh:${TARGET.id}`
  })
  store.setWorktreeLineage(worktreeId, {
    worktreeId,
    worktreeInstanceId: 'instance-1',
    parentWorktreeId: 'repo-1',
    parentWorktreeInstanceId: 'main-instance',
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 3
  })
  store.setWorkspaceLineage({
    childWorkspaceKey: worktreeWorkspaceKey(worktreeId),
    childInstanceId: 'instance-1',
    parentWorkspaceKey: folderWorkspaceKey(folderWorkspaceId),
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 4
  })
  store.saveSparsePreset({
    id: 'preset-1',
    repoId: 'repo-1',
    name: 'Renderer',
    directories: ['src/renderer'],
    createdAt: 5,
    updatedAt: 6
  })
  store.mergeRetiredWorktreeNames('repo-1', ['nautilus'])
  const repo = store.getRepos().find((entry) => entry.id === 'repo-1')
  if (!repo) {
    throw new Error('expected source repo')
  }
  const namespaceKey = getRemoteRetirementNamespaceKey(repo, store.getSettings(), (targetId) =>
    store.getSshTarget(targetId)
  )
  if (!namespaceKey) {
    throw new Error('expected source namespace')
  }
  store.mergeRetiredWorktreeNamesForNamespace(namespaceKey, ['seahorse'])
  return namespaceKey
}

export function commitDestination(
  store: ReturnType<typeof createStore>,
  manifest: ReturnType<typeof createOrcadMigrationManifest>
): void {
  store.beginOrcadMigrationSourceCutover(manifest, 'environment-1')
  store.markOrcadMigrationDestinationCommitted(manifest.migrationId, {
    state: 'committed',
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256,
    receipt: receipt(manifest)
  })
}

export function receipt(
  manifest: ReturnType<typeof createOrcadMigrationManifest>
): OrcadMigrationImportReceipt {
  return {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256,
    source: manifest.source,
    importedAt: '2026-08-30T12:03:00.000Z',
    repositoryIds: manifest.payload.repositories.map((repo) => repo.id),
    projectGroupIds: manifest.payload.projectGroups.map((group) => group.id),
    folderWorkspaceIds: manifest.payload.folderWorkspaces.map((workspace) => workspace.id)
  }
}
