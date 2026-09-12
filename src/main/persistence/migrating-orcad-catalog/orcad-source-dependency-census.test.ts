import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { Automation, AutomationRun } from '../../../shared/automations-types'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  type OrcadMigrationManifest
} from '../../../shared/orcad-migration-manifest'
import type { Repo } from '../../../shared/repo-types'
import type { SshTarget } from '../../../shared/ssh-types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { getRemoteRetirementNamespaceKey } from '../../worktree-name-retirement'
import { collectOrcadMigrationSourceDependencyCensus } from './orcad-source-dependency-census'

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
  it('allows a static catalog with no unrepresented dependent state', () => {
    const state = getDefaultPersistedState('/home/test')
    state.sshTargets = [TARGET]
    state.repos = [REPO]
    state.folderWorkspaces = [FOLDER]

    expect(collectOrcadMigrationSourceDependencyCensus(state, MANIFEST)).toMatchObject({
      totalCount: 0
    })
  })

  it('counts every currently unrepresented ownership surface before remote mutation', () => {
    const state = getDefaultPersistedState('/home/test')
    const worktreeId = `${REPO.id}::/srv/worktree`
    const folderKey = folderWorkspaceKey(FOLDER.id)
    state.sshTargets = [
      {
        ...TARGET,
        portForwards: [{ localPort: 3000, remoteHost: '127.0.0.1', remotePort: 3000 }]
      }
    ]
    state.repos = [REPO]
    state.folderWorkspaces = [FOLDER]
    state.sshRemotePtyLeases = [
      {
        targetId: TARGET.id,
        ptyId: 'pty-1',
        worktreeId,
        state: 'detached',
        createdAt: 1,
        updatedAt: 1
      }
    ]
    state.sshPtyConsumerRecoveries = [
      {
        targetId: TARGET.id,
        clientInstanceId: 'client-1',
        serverBuildId: 'build-1',
        clientGeneration: 1,
        ownerGeneration: 1,
        ownerLease: 'lease-1'
      }
    ]
    state.workspaceSessionsByHostId = {
      [`ssh:${TARGET.id}`]: {
        ...state.workspaceSession,
        tabsByWorktree: {
          [worktreeId]: [
            {
              id: 'tab-1',
              ptyId: 'pty-1',
              worktreeId,
              title: 'Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        }
      }
    }
    state.worktreeMeta[worktreeId] = {
      displayName: 'Worktree',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 1,
      hostId: `ssh:${TARGET.id}`
    }
    state.worktreeLineageById[worktreeId] = {
      worktreeId,
      worktreeInstanceId: 'instance-1',
      parentWorktreeId: REPO.id,
      parentWorktreeInstanceId: 'instance-parent',
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 1
    }
    state.workspaceLineageByChildKey[worktreeWorkspaceKey(worktreeId)] = {
      childWorkspaceKey: worktreeWorkspaceKey(worktreeId),
      parentWorkspaceKey: folderKey,
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 1
    }
    state.sparsePresetsByRepo[REPO.id] = [
      {
        id: 'preset-1',
        repoId: REPO.id,
        name: 'UI',
        directories: ['src/renderer'],
        createdAt: 1,
        updatedAt: 1
      }
    ]
    state.retiredWorktreeNamesByRepo![REPO.id] = { exhaustedTiers: 0, names: ['nautilus'] }
    const namespaceKey = getRemoteRetirementNamespaceKey(REPO, state.settings, (targetId) =>
      state.sshTargets.find((target) => target.id === targetId)
    )
    expect(namespaceKey).not.toBeNull()
    if (!namespaceKey || !state.retiredWorktreeNamesByNamespace) {
      throw new Error('expected source retirement namespace')
    }
    state.retiredWorktreeNamesByNamespace[namespaceKey] = {
      exhaustedTiers: 0,
      names: ['seahorse']
    }
    state.automations = [automation()]
    state.automationRuns = [automationRun()]
    state.mobileClientTabSelectionsByDeviceId = {
      'device-1': {
        [folderKey]: { activeTabId: null, activeGroupId: null, activeTabIdByGroupId: {} }
      }
    }
    state.ui.lastActiveRepoId = REPO.id

    expect(collectOrcadMigrationSourceDependencyCensus(state, MANIFEST)).toEqual({
      totalCount: 14,
      counts: {
        automation: 1,
        'automation-run': 1,
        'mobile-tab-selection': 1,
        'retired-worktree-name': 2,
        'saved-port-forward': 1,
        'sparse-preset': 1,
        'terminal-lease': 1,
        'terminal-recovery': 1,
        'ui-routing': 1,
        'workspace-lineage': 1,
        'workspace-session': 1,
        'worktree-lineage': 1,
        'worktree-metadata': 1
      }
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

    expect(collectOrcadMigrationSourceDependencyCensus(state, MANIFEST).totalCount).toBe(0)
  })

  it('does not strand a static migration on an owner-recovery tombstone after all leases are final', () => {
    const state = getDefaultPersistedState('/home/test')
    state.sshTargets = [TARGET]
    state.repos = [REPO]
    state.folderWorkspaces = [FOLDER]
    state.sshRemotePtyLeases = [
      {
        targetId: TARGET.id,
        ptyId: 'pty-finished',
        state: 'terminated',
        createdAt: 1,
        updatedAt: 2
      }
    ]
    state.sshPtyConsumerRecoveries = [
      {
        targetId: TARGET.id,
        clientInstanceId: 'client-1',
        serverBuildId: 'build-1',
        clientGeneration: 1,
        ownerGeneration: 1,
        ownerLease: 'lease-1'
      }
    ]

    expect(collectOrcadMigrationSourceDependencyCensus(state, MANIFEST)).toMatchObject({
      totalCount: 0,
      counts: { 'terminal-recovery': 0 }
    })
  })
})

function automation(): Automation {
  return {
    id: 'automation-1',
    name: 'Remote task',
    prompt: 'Run checks',
    precheck: null,
    agentId: 'codex',
    projectId: REPO.id,
    executionTargetType: 'ssh',
    executionTargetId: TARGET.id,
    executionTargetGeneration: TARGET.generation,
    schedulerOwner: 'ssh_bridge',
    workspaceMode: 'existing',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 1,
    enabled: true,
    nextRunAt: 2,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 60,
    createdAt: 1,
    updatedAt: 1
  }
}

function automationRun(): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'automation-1',
    title: 'Remote task #1',
    scheduledFor: 1,
    status: 'completed',
    trigger: 'scheduled',
    workspaceId: null,
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: 1,
    dispatchedAt: 1,
    createdAt: 1
  }
}
