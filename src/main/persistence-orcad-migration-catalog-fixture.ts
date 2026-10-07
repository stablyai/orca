import type { FolderWorkspace } from '../shared/folder-workspace-types'
import type { Automation, AutomationRun } from '../shared/automations-types'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  type OrcadMigrationDormantStatePayload,
  type OrcadMigrationManifest
} from '../shared/orcad-migration-manifest'
import type { ProjectGroup } from '../shared/project-group-types'
import type { Repo } from '../shared/repo-types'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../shared/workspace-scope'
import { computeOrcadMigrationManifestSha256 } from './orcad/orcad-migration-manifest-digest'

export const PROJECT_GROUP: ProjectGroup = {
  id: 'group-1',
  name: 'Production',
  parentPath: '/srv',
  connectionId: 'ssh-prod',
  executionHostId: 'ssh:ssh-prod',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 1,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 2
}

export const REPOSITORY: Repo = {
  id: 'repo-1',
  path: '/srv/repo-1',
  displayName: 'Repository',
  badgeColor: '#737373',
  addedAt: 3,
  kind: 'git',
  connectionId: 'ssh-prod',
  executionHostId: 'ssh:ssh-prod',
  projectGroupId: 'group-1'
}

export const FOLDER_WORKSPACE: FolderWorkspace = {
  id: 'folder-1',
  projectGroupId: 'group-1',
  name: 'Investigate',
  folderPath: '/srv/investigate',
  connectionId: 'ssh-prod',
  executionHostId: 'ssh:ssh-prod',
  linkedTask: null,
  comment: 'Keep this note',
  isArchived: false,
  isUnread: true,
  isPinned: true,
  sortOrder: 4,
  lastActivityAt: 5,
  createdAt: 6,
  updatedAt: 7
}

export const DORMANT_WORKTREE_ID = 'repo-1::/srv/repo-1-worktree'
export const DORMANT_NAMESPACE = 'local:/srv/orca-worktrees'
export const DORMANT_LEAF_ID = '11111111-1111-4111-8111-111111111111'
export const DORMANT_AUTOMATION: Automation = {
  id: 'automation-dormant',
  name: 'Nightly checks',
  prompt: 'Run tests',
  precheck: null,
  agentId: 'codex',
  runContext: {
    kind: 'workspace-run',
    projectId: 'repo:repo-1',
    hostId: 'local',
    projectHostSetupId: REPOSITORY.id,
    repoId: REPOSITORY.id,
    path: REPOSITORY.path
  },
  sourceContext: null,
  projectId: REPOSITORY.id,
  executionTargetType: 'local',
  executionTargetId: 'local',
  schedulerOwner: 'remote_host_service',
  workspaceMode: 'new_per_run',
  workspaceId: null,
  baseBranch: 'main',
  reuseSession: false,
  timezone: 'UTC',
  rrule: 'FREQ=DAILY',
  dtstart: 1,
  enabled: false,
  nextRunAt: 2,
  missedRunPolicy: 'run_once_within_grace',
  missedRunGraceMinutes: 60,
  createdAt: 1,
  updatedAt: 2
}
export const DORMANT_AUTOMATION_RUN: AutomationRun = {
  id: 'run-dormant',
  automationId: DORMANT_AUTOMATION.id,
  runContext: DORMANT_AUTOMATION.runContext,
  sourceContext: null,
  title: 'Nightly checks run 1',
  scheduledFor: 1,
  status: 'completed',
  trigger: 'scheduled',
  workspaceId: null,
  sessionKind: 'terminal',
  chatSessionId: null,
  terminalSessionId: 'tab-history',
  terminalPaneKey: null,
  terminalPtyId: 'pty-history',
  outputSnapshot: {
    format: 'plain_text',
    content: 'all green',
    capturedAt: 2,
    truncated: false
  },
  precheckResult: null,
  usage: null,
  error: null,
  startedAt: 1,
  dispatchedAt: 1,
  createdAt: 1,
  runNumber: 1
}

export function dormantState(): OrcadMigrationDormantStatePayload {
  return {
    version: 1,
    worktreeMeta: [
      {
        sourceKey: DORMANT_WORKTREE_ID,
        worktreeId: DORMANT_WORKTREE_ID,
        meta: {
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
          lastActivityAt: 4_102_444_800_000,
          hostId: 'local'
        }
      }
    ],
    worktreeLineage: [
      {
        sourceKey: DORMANT_WORKTREE_ID,
        worktreeId: DORMANT_WORKTREE_ID,
        lineage: {
          worktreeId: DORMANT_WORKTREE_ID,
          worktreeInstanceId: 'instance-1',
          parentWorktreeId: REPOSITORY.id,
          parentWorktreeInstanceId: 'main-instance',
          origin: 'manual',
          capture: { source: 'manual-action', confidence: 'explicit' },
          createdAt: 3
        }
      }
    ],
    workspaceLineage: [
      {
        sourceKey: worktreeWorkspaceKey(DORMANT_WORKTREE_ID),
        childWorkspaceKey: worktreeWorkspaceKey(DORMANT_WORKTREE_ID),
        lineage: {
          childWorkspaceKey: worktreeWorkspaceKey(DORMANT_WORKTREE_ID),
          childInstanceId: 'instance-1',
          parentWorkspaceKey: folderWorkspaceKey(FOLDER_WORKSPACE.id),
          parentInstanceId: null,
          origin: 'manual',
          capture: { source: 'manual-action', confidence: 'explicit' },
          createdAt: 4
        }
      }
    ],
    sparsePresets: [
      {
        id: 'preset-1',
        repoId: REPOSITORY.id,
        name: 'Renderer',
        directories: ['src/renderer'],
        createdAt: 5,
        updatedAt: 6
      }
    ],
    retiredWorktreeNames: [
      { repoId: REPOSITORY.id, registry: { exhaustedTiers: 0, names: ['nautilus'] } }
    ],
    retiredWorktreeNamespaces: [
      {
        sourceNamespaceKeys: ['ssh:source:/srv/orca-worktrees'],
        namespaceKey: DORMANT_NAMESPACE,
        registry: { exhaustedTiers: 0, names: ['seahorse'] }
      }
    ],
    workspaceSession: {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [DORMANT_WORKTREE_ID]: [
          {
            id: 'tab-dormant',
            ptyId: null,
            worktreeId: DORMANT_WORKTREE_ID,
            title: 'Dormant terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 7
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
      }
    },
    automations: [structuredClone(DORMANT_AUTOMATION)],
    automationRuns: [structuredClone(DORMANT_AUTOMATION_RUN)]
  }
}

export function manifest(overrides: Partial<OrcadMigrationManifest> = {}): OrcadMigrationManifest {
  const unsigned = {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: 'migration-1',
    createdAt: '2026-08-30T12:00:00.000Z',
    source: {
      sshTargetId: 'ssh-prod',
      sshTargetGeneration: 8,
      targetLabel: 'Production'
    },
    payload: {
      repositories: [REPOSITORY],
      projectGroups: [PROJECT_GROUP],
      folderWorkspaces: [FOLDER_WORKSPACE]
    },
    ...withoutDigest(overrides)
  }
  return {
    ...unsigned,
    manifestSha256: overrides.manifestSha256 ?? computeOrcadMigrationManifestSha256(unsigned)
  }
}

export function withoutDigest(
  value: Partial<OrcadMigrationManifest>
): Partial<Omit<OrcadMigrationManifest, 'manifestSha256'>> {
  const { manifestSha256: _digest, ...rest } = value
  return rest
}
