import { describe, expect, it } from 'vitest'
import type { Store } from '../persistence/loading-store/store'
import type { Automation } from '../../shared/automations/automation-definition'
import type { WorkspaceRunContext } from '../../shared/work-items/task-source-context'
import type { ProjectHostSetup } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import {
  projectAutomationSelector,
  type AutomationProjectionContext
} from '../../shared/automations/ownership/automation-list-scope'
import { toAutomationOwnerPrecondition } from '../../shared/automations/ownership/automation-owner-precondition'

import { resolveAutomationRunTarget } from './run-target-resolution'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#fff',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

function makeSetup(overrides: Partial<ProjectHostSetup> = {}): ProjectHostSetup {
  return {
    id: 'setup-1',
    projectId: 'github:o/r',
    hostId: 'local',
    repoId: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeRunContext(overrides: Partial<WorkspaceRunContext> = {}): WorkspaceRunContext {
  return {
    kind: 'workspace-run',
    projectId: 'repo:repo-1',
    hostId: 'local',
    projectHostSetupId: 'setup-1',
    repoId: 'repo-1',
    path: '/repo',
    ...overrides
  }
}

function makeAutomation(
  runContext: WorkspaceRunContext | null,
  overrides: Partial<Automation> = {}
): Automation {
  return {
    id: 'automation-1',
    name: 'Nightly',
    prompt: 'Run checks',
    precheck: null,
    agentId: 'codex',
    projectId: 'repo-1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 1,
    enabled: true,
    nextRunAt: 2,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 1,
    updatedAt: 1,
    runContext,
    ...overrides
  } as Automation
}

function makeStore(
  setups: ProjectHostSetup[],
  repos: Repo[],
  projectedAutomation?: Automation
): Store {
  const projectionContext: AutomationProjectionContext = {
    storageAuthority: 'desktop',
    sshTargetGeneration: () => 7,
    repoConnectionId: (repoId) => {
      const repo = repos.find((entry) => entry.id === repoId)
      return repo ? repo.connectionId?.trim() || null : undefined
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: run-target resolution reads only these Store members.
  return {
    getProjectHostSetups: () => setups,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getRepos: () => repos,
    automationOwnerPrecondition: () =>
      projectedAutomation
        ? toAutomationOwnerPrecondition(
            projectAutomationSelector(projectedAutomation, projectionContext)
          )
        : { selector: { kind: 'self' } },
    automationCapturedHostIssue: () => null
  } as unknown as Store
}

describe('resolveAutomationRunTarget projectId drift', () => {
  it('resolves when only the derived projectId tier differs (repo: snapshot vs github: setup)', () => {
    const store = makeStore([makeSetup()], [makeRepo()])
    const automation = makeAutomation(makeRunContext({ projectId: 'repo:repo-1' }))

    const result = resolveAutomationRunTarget(store, automation)

    expect(result).toMatchObject({ ok: true, cwd: '/repo' })
  })

  it('still blocks when the repoId no longer matches the setup', () => {
    const store = makeStore([makeSetup({ repoId: 'repo-2' })], [makeRepo()])
    const automation = makeAutomation(makeRunContext({ repoId: 'repo-1' }))

    const result = resolveAutomationRunTarget(store, automation)

    expect(result).toMatchObject({ ok: false })
  })
})

describe('resolveAutomationRunTarget on a managed SSH host', () => {
  it('skips a desktop row whose SSH host now runs automations on its Orca server', () => {
    const sshContext = { hostId: 'ssh:box', path: '/srv/repo' } as const
    const store = makeStore(
      [makeSetup(sshContext)],
      [makeRepo({ connectionId: 'box', path: '/srv/repo' })]
    )
    store.getSshTarget = (id: string) =>
      id === 'box'
        ? {
            id,
            label: 'Build box',
            host: 'box',
            port: 22,
            username: 'me',
            orcadFence: { environmentId: 'env-1' }
          }
        : undefined
    const automation = makeAutomation(makeRunContext(sshContext), {
      executionTargetType: 'ssh',
      executionTargetId: 'box'
    })

    expect(resolveAutomationRunTarget(store, automation)).toMatchObject({
      ok: false,
      errorCode: 'managedHostServer',
      errorParams: { host: 'Build box' }
    })
  })
})

describe('resolveAutomationRunTarget on a managed SSH workspace pin', () => {
  it('skips a local row whose pinned workspace is on a managed SSH host', () => {
    const store = makeStore([makeSetup()], [makeRepo()])
    store.automationOwnerPrecondition = () => ({
      selector: { kind: 'ssh', targetId: 'box', targetGeneration: 7 }
    })
    store.getSshTarget = (id: string) =>
      id === 'box'
        ? {
            id,
            label: 'Build box',
            host: 'box',
            port: 22,
            username: 'me',
            orcadFence: { environmentId: 'env-1' }
          }
        : undefined

    expect(resolveAutomationRunTarget(store, makeAutomation(makeRunContext()))).toMatchObject({
      ok: false,
      errorCode: 'managedHostServer'
    })
  })
})
