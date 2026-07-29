import { describe, expect, it } from 'vitest'
import type { Store } from '../persistence'
import type { Automation } from '../../shared/automations-types'
import type { WorkspaceRunContext } from '../../shared/task-source-context'
import type { ProjectHostSetup, Repo } from '../../shared/types'
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

function makeAutomation(runContext: WorkspaceRunContext): Automation {
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
    runContext
  } as Automation
}

function makeStore(setups: ProjectHostSetup[], repos: Repo[]): Store {
  return {
    getProjectHostSetups: () => setups,
    getRepo: (id: string) => repos.find((repo) => repo.id === id)
  } as unknown as Store
}

describe('resolveAutomationRunTarget projectId drift', () => {
  it('resolves when only the derived projectId tier differs (repo: snapshot vs github: setup)', () => {
    const store = makeStore([makeSetup()], [makeRepo()])
    const automation = makeAutomation(makeRunContext({ projectId: 'repo:repo-1' }))

    const result = resolveAutomationRunTarget(store, automation)

    expect(result).toMatchObject({ ok: true, cwd: '/repo' })
  })

  it('resolves when the snapshot is at the git: tier and the setup climbed to github:', () => {
    const store = makeStore([makeSetup()], [makeRepo()])
    const automation = makeAutomation(makeRunContext({ projectId: 'git:github.com/o/r' }))

    const result = resolveAutomationRunTarget(store, automation)

    expect(result).toMatchObject({ ok: true, cwd: '/repo' })
  })

  it('still blocks when the repoId no longer matches the setup', () => {
    const store = makeStore([makeSetup({ repoId: 'repo-2' })], [makeRepo()])
    const automation = makeAutomation(makeRunContext({ repoId: 'repo-1' }))

    const result = resolveAutomationRunTarget(store, automation)

    expect(result).toMatchObject({ ok: false })
  })

  it('still blocks when the hostId no longer matches the setup', () => {
    // Guard returns at the setup hostId/repoId check before any repo lookup, so
    // the repo's execution host is irrelevant here — assert the guard's own error.
    const store = makeStore([makeSetup({ hostId: 'ssh:devbox' })], [makeRepo()])
    const automation = makeAutomation(makeRunContext({ hostId: 'local' }))

    const result = resolveAutomationRunTarget(store, automation)

    expect(result).toMatchObject({
      ok: false,
      error: 'Automation run target no longer matches the selected project host setup.'
    })
  })

  it("still blocks when the repo's execution host drifted off the automation host", () => {
    // Setup/context hostId agree, but the repo itself now executes on another host —
    // pins the repo-execution-host check that lives past the setup-match guard.
    const store = makeStore([makeSetup()], [makeRepo({ executionHostId: 'ssh:devbox' })])
    const automation = makeAutomation(makeRunContext())

    const result = resolveAutomationRunTarget(store, automation)

    expect(result).toMatchObject({
      ok: false,
      error: 'Repository is no longer attached to the selected automation host.'
    })
  })

  it('still blocks when the path no longer matches the setup', () => {
    const store = makeStore([makeSetup({ path: '/repo/new' })], [makeRepo({ path: '/repo/new' })])
    const automation = makeAutomation(makeRunContext({ path: '/repo/old' }))

    const result = resolveAutomationRunTarget(store, automation)

    expect(result).toMatchObject({
      ok: false,
      error: 'Project path for the selected automation host has changed.'
    })
  })
})
