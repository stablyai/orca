import { describe, expect, it } from 'vitest'
import { migrateAutomationOwners } from './automation-owner-migration'
import {
  AUTOMATION_ORPHAN_ISSUES,
  projectAutomationSelector
} from '../../shared/automation-list-scope'
import type { Automation } from '../../shared/automations-types'
import type { SshTarget } from '../../shared/ssh-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import { folderWorkspaceKey } from '../../shared/workspace-scope'

const NOW = 1_700_000_000_000

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    name: 'Nightly',
    prompt: 'go',
    precheck: null,
    agentId: 'codex',
    projectId: 'repo-1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: NOW,
    enabled: true,
    nextRunAt: NOW,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  }
}

function makeTarget(overrides: Partial<SshTarget> = {}): SshTarget {
  return {
    id: 'ssh-1',
    label: 'Dev box',
    host: 'dev.example.com',
    port: 22,
    username: 'tim',
    ...overrides
  }
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'Repo One',
    badgeColor: '#fff',
    addedAt: NOW,
    ...overrides
  }
}

function migrate(input: {
  automations?: Automation[]
  sshTargets?: SshTarget[]
  repos?: Repo[]
  folderWorkspaces?: FolderWorkspace[]
  projectGroups?: ProjectGroup[]
  sshTargetGenerationCounter?: number
  storageAuthority?: 'desktop' | 'runtime'
}) {
  return migrateAutomationOwners({
    automations: input.automations ?? [],
    sshTargets: input.sshTargets ?? [],
    repos: input.repos ?? [],
    folderWorkspaces: input.folderWorkspaces,
    projectGroups: input.projectGroups,
    sshTargetGenerationCounter: input.sshTargetGenerationCounter,
    storageAuthority: input.storageAuthority
  })
}

/** A folder workspace rooted on an SSH host: its scope connection pins every record inside it. */
function pinnedWorkspaceState(): {
  folderWorkspaces: FolderWorkspace[]
  projectGroups: ProjectGroup[]
} {
  return {
    projectGroups: [
      {
        id: 'group-1',
        name: 'Group',
        parentPath: '/srv',
        parentGroupId: null,
        createdFrom: 'folder-scan',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: NOW,
        updatedAt: NOW
      }
    ],
    folderWorkspaces: [
      {
        id: 'fw-1',
        projectGroupId: 'group-1',
        name: 'Remote root',
        folderPath: '/srv/remote',
        connectionId: 'ssh-1',
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: NOW,
        createdAt: NOW,
        updatedAt: NOW
      }
    ]
  }
}

/** The same workspace after its execution host was changed outside the automation editor. */
function repinnedWorkspaceState(connectionId: string): {
  folderWorkspaces: FolderWorkspace[]
  projectGroups: ProjectGroup[]
} {
  const state = pinnedWorkspaceState()
  return {
    ...state,
    folderWorkspaces: state.folderWorkspaces.map((workspace) => ({ ...workspace, connectionId }))
  }
}

function pinnedLocalAutomation(overrides: Partial<Automation> = {}): Automation {
  return makeAutomation({
    workspaceMode: 'existing',
    workspaceId: folderWorkspaceKey('fw-1'),
    ...overrides
  })
}

describe('migrateAutomationOwners', () => {
  it('stamps generations on legacy targets and lets a live SSH automation adopt one', () => {
    const result = migrate({
      automations: [
        makeAutomation({
          executionTargetType: 'ssh',
          executionTargetId: 'ssh-1',
          schedulerOwner: 'ssh_bridge'
        })
      ],
      sshTargets: [makeTarget()]
    })
    expect(result.changed).toBe(true)
    expect(result.sshTargets[0].generation).toBe(1)
    expect(result.automations[0].executionTargetGeneration).toBe(1)
    expect(result.automations[0].enabled).toBe(true)
    expect(result.sshTargetGenerationCounter).toBe(1)
  })

  it('is idempotent', () => {
    const first = migrate({
      automations: [
        makeAutomation({
          executionTargetType: 'ssh',
          executionTargetId: 'ssh-1',
          schedulerOwner: 'ssh_bridge'
        }),
        makeAutomation({ id: 'auto-2', executionTargetType: 'ssh', executionTargetId: 'ssh-gone' })
      ],
      sshTargets: [makeTarget()],
      repos: [makeRepo()]
    })
    const second = migrateAutomationOwners({
      automations: first.automations,
      sshTargets: first.sshTargets,
      repos: [makeRepo()],
      sshTargetGenerationCounter: first.sshTargetGenerationCounter
    })
    expect(second.changed).toBe(false)
    expect(second.automations).toEqual(first.automations)
    expect(second.sshTargets).toEqual(first.sshTargets)
  })

  // Refusing to run an orphan is dispatch's live verdict, not a persisted write:
  // the record keeps its selector and its enablement untouched.
  it('leaves an automation whose target is gone in place without rewriting or disabling it', () => {
    const automation = makeAutomation({
      executionTargetType: 'ssh',
      executionTargetId: 'ssh-gone',
      schedulerOwner: 'ssh_bridge'
    })
    const result = migrate({
      automations: [automation],
      repos: [makeRepo({ connectionId: 'ssh-gone' })]
    })
    const migrated = result.automations[0]
    expect(migrated).toEqual(automation)
    expect(migrated.executionTargetGeneration).toBeUndefined()
  })

  it.each([
    { label: 'schedulerOwner', overrides: { schedulerOwner: 'remote_host_service' as const } },
    {
      label: 'runContext.hostId',
      overrides: {
        runContext: {
          kind: 'workspace-run' as const,
          projectId: 'p',
          hostId: 'runtime:env-1' as const,
          projectHostSetupId: 's',
          repoId: 'repo-1',
          path: '/tmp/repo'
        }
      }
    }
  ])(
    'leaves an ambiguous desktop record flagged by $label unstamped and in place',
    ({ overrides }) => {
      const result = migrate({ automations: [makeAutomation(overrides)] })
      const migrated = result.automations[0]
      expect(migrated.enabled).toBe(true)
      expect(migrated.executionTargetGeneration).toBeUndefined()
      expect(migrated.executionTargetType).toBe('local')
      expect(migrated.executionTargetId).toBe('local')
      expect(result.automations).toHaveLength(1)
    }
  )

  it.each([
    { label: 'schedulerOwner', overrides: { schedulerOwner: 'remote_host_service' as const } },
    {
      label: 'runContext.hostId',
      overrides: {
        runContext: {
          kind: 'workspace-run' as const,
          projectId: 'p',
          hostId: 'runtime:env-1' as const,
          projectHostSetupId: 's',
          repoId: 'repo-1',
          path: '/tmp/repo'
        }
      }
    }
  ])('keeps a runtime-owned record flagged by $label enabled and owned', ({ overrides }) => {
    const result = migrate({
      automations: [makeAutomation(overrides)],
      repos: [makeRepo()],
      storageAuthority: 'runtime'
    })
    const migrated = result.automations[0]
    expect(migrated.enabled).toBe(true)
    expect(
      projectAutomationSelector(migrated, {
        storageAuthority: 'runtime',
        sshTargetGeneration: () => undefined,
        repoConnectionId: () => null
      })
    ).toEqual({ kind: 'self' })
  })

  it('leaves a differing captured generation alone so the record stays a replaced orphan', () => {
    const result = migrate({
      automations: [
        makeAutomation({
          executionTargetType: 'ssh',
          executionTargetId: 'ssh-1',
          schedulerOwner: 'ssh_bridge',
          executionTargetGeneration: 4
        })
      ],
      sshTargets: [makeTarget({ generation: 9 })],
      sshTargetGenerationCounter: 9
    })
    const migrated = result.automations[0]
    expect(migrated.executionTargetGeneration).toBe(4)
    expect(migrated.enabled).toBe(true)
    expect(
      projectAutomationSelector(migrated, {
        sshTargetGeneration: () => 9,
        repoConnectionId: () => 'ssh-1'
      })
    ).toEqual({ kind: 'orphan', issue: AUTOMATION_ORPHAN_ISSUES.targetReplaced })
  })

  it('leaves a healthy local automation untouched', () => {
    const result = migrate({ automations: [makeAutomation()] })
    expect(result.changed).toBe(false)
    expect(result.automations[0].enabled).toBe(true)
  })

  it('preserves unknown persisted fields on migrated records and targets', () => {
    const automation = {
      ...makeAutomation({ executionTargetType: 'ssh', executionTargetId: 'ssh-1' }),
      futureField: 'keep'
    }
    const target = { ...makeTarget(), futureTargetField: 'keep' }
    const result = migrate({
      automations: [automation as Automation],
      sshTargets: [target as SshTarget]
    })
    expect(result.automations[0]).toMatchObject({ futureField: 'keep' })
    expect(result.sshTargets[0]).toMatchObject({ futureTargetField: 'keep' })
  })

  it('backfills the pinned registration for a local record its folder workspace puts on SSH', () => {
    const result = migrate({
      automations: [pinnedLocalAutomation()],
      sshTargets: [makeTarget({ generation: 4 })],
      sshTargetGenerationCounter: 4,
      ...pinnedWorkspaceState()
    })
    expect(result.changed).toBe(true)
    expect(result.automations[0].executionTargetType).toBe('local')
    expect(result.automations[0].executionTargetGeneration).toBe(4)
  })

  it('never overwrites a differing capture on a pinned record, so it stays a replaced orphan', () => {
    const workspace = pinnedWorkspaceState()
    const result = migrate({
      automations: [pinnedLocalAutomation({ executionTargetGeneration: 4 })],
      sshTargets: [makeTarget({ generation: 9 })],
      sshTargetGenerationCounter: 9,
      ...workspace
    })
    const migrated = result.automations[0]
    expect(migrated.executionTargetGeneration).toBe(4)
    expect(migrated.enabled).toBe(true)
    expect(
      projectAutomationSelector(migrated, {
        sshTargetGeneration: () => 9,
        repoConnectionId: () => null,
        workspaceHost: () => ({ kind: 'ssh', targetId: 'ssh-1' })
      })
    ).toEqual({ kind: 'orphan', issue: AUTOMATION_ORPHAN_ISSUES.targetReplaced })
  })

  it('is idempotent for pinned records', () => {
    const workspace = pinnedWorkspaceState()
    const first = migrate({
      automations: [pinnedLocalAutomation()],
      sshTargets: [makeTarget({ generation: 4 })],
      sshTargetGenerationCounter: 4,
      ...workspace
    })
    const second = migrateAutomationOwners({
      automations: first.automations,
      sshTargets: first.sshTargets,
      repos: [],
      ...workspace,
      sshTargetGenerationCounter: first.sshTargetGenerationCounter
    })
    expect(second.changed).toBe(false)
    expect(second.automations).toEqual(first.automations)
  })

  it('leaves an unpinned local record without a capture', () => {
    const result = migrate({
      automations: [makeAutomation()],
      sshTargets: [makeTarget({ generation: 4 })],
      sshTargetGenerationCounter: 4,
      ...pinnedWorkspaceState()
    })
    expect(result.automations[0].executionTargetGeneration).toBeUndefined()
  })

  // The pin, not the project, is what dispatch resolves; a pin this authority cannot
  // vouch for stays unstamped so it classifies like an unresolvable SSH selector.
  it('never stamps a pinned local record whose pin names an unregistered target', () => {
    const result = migrate({
      automations: [pinnedLocalAutomation()],
      sshTargets: [],
      ...pinnedWorkspaceState()
    })
    const migrated = result.automations[0]
    expect(migrated.enabled).toBe(true)
    expect(migrated.executionTargetGeneration).toBeUndefined()
    expect(migrated.executionTargetType).toBe('local')
    expect(migrated.executionTargetId).toBe('local')
  })

  // Absence of evidence: with no workspace list supplied, nothing proves the record is pinned.
  it('leaves a record alone when no workspace list was supplied to prove a pin', () => {
    const result = migrate({ automations: [pinnedLocalAutomation()], sshTargets: [] })
    expect(result.automations[0].enabled).toBe(true)
    expect(result.automations[0].executionTargetGeneration).toBeUndefined()
  })

  it('follows an external re-pin onto the registration the workspace names now', () => {
    const result = migrate({
      automations: [pinnedLocalAutomation({ executionTargetGeneration: 4 })],
      sshTargets: [makeTarget({ generation: 4 }), makeTarget({ id: 'ssh-2', generation: 9 })],
      sshTargetGenerationCounter: 9,
      ...repinnedWorkspaceState('ssh-2')
    })
    const migrated = result.automations[0]
    expect(migrated.executionTargetGeneration).toBe(9)
    expect(migrated.enabled).toBe(true)
    expect(
      projectAutomationSelector(migrated, {
        sshTargetGeneration: (targetId) => (targetId === 'ssh-2' ? 9 : 4),
        repoConnectionId: () => null,
        workspaceHost: () => ({ kind: 'ssh', targetId: 'ssh-2' })
      })
    ).toEqual({ kind: 'ssh', targetId: 'ssh-2', targetGeneration: 9 })
  })

  it('cannot reissue a generation an automation already captured after a counter rollback', () => {
    const result = migrate({
      automations: [
        makeAutomation({
          executionTargetType: 'ssh',
          executionTargetId: 'ssh-gone',
          executionTargetGeneration: 9
        })
      ],
      sshTargets: [makeTarget({ id: 'ssh-new' })],
      sshTargetGenerationCounter: 2
    })
    expect(result.sshTargets[0].generation).toBe(10)
    expect(result.sshTargetGenerationCounter).toBe(10)
  })
})
