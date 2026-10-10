import { describe, expect, it } from 'vitest'
import type { Store } from '../persistence'
import type { Automation } from '../../shared/automations-types'
import type { WorkspaceRunContext } from '../../shared/task-source-context'
import type { ProjectHostSetup } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import {
  projectAutomationSelector,
  type AutomationProjectionContext
} from '../../shared/automation-list-scope'
import { toAutomationOwnerPrecondition } from '../../shared/automation-owner-precondition'
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies every Store method exercised by the resolver.
  return {
    getProjectHostSetups: () => setups,
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    automationOwnerPrecondition: () =>
      projectedAutomation
        ? toAutomationOwnerPrecondition(
            projectAutomationSelector(projectedAutomation, projectionContext)
          )
        : { selector: { kind: 'self' } },
    automationCapturedHostIssue: () => null
  } as unknown as Store
}

describe('resolveAutomationRunTarget owner projection', () => {
  it('refuses a context-less local selector whose SSH-backed repo makes it malformed', () => {
    const repo = makeRepo({ connectionId: 'ssh-1' })
    const automation = makeAutomation(null)
    const store = makeStore([], [repo], automation)

    expect(resolveAutomationRunTarget(store, automation)).toEqual({
      ok: false,
      error: 'This automation has no host to run on.'
    })
  })

  it('keeps a generation-less legacy SSH selector runnable when its host is current', () => {
    const repo = makeRepo({ connectionId: 'ssh-1' })
    const automation = makeAutomation(null, {
      executionTargetType: 'ssh',
      executionTargetId: 'ssh-1'
    })
    const store = makeStore([], [repo], automation)

    expect(resolveAutomationRunTarget(store, automation)).toMatchObject({
      ok: true,
      cwd: '/repo'
    })
  })
})

describe('duplicate setup and repo IDs on saved automation hosts', () => {
  it.each([false, true])('resolves the saved SSH owner (SSH first: %s)', (sshFirst) => {
    const localRepo = makeRepo()
    const remoteRepo = makeRepo({ connectionId: 'ssh-1', path: '/remote' })
    const localSetup = makeSetup()
    const remoteSetup = makeSetup({ hostId: 'ssh:ssh-1', path: '/remote' })
    const store = makeStore(
      sshFirst ? [remoteSetup, localSetup] : [localSetup, remoteSetup],
      sshFirst ? [remoteRepo, localRepo] : [localRepo, remoteRepo]
    )
    expect(
      resolveAutomationRunTarget(
        store,
        makeAutomation(makeRunContext({ hostId: 'ssh:ssh-1', path: '/remote' }))
      )
    ).toMatchObject({ ok: true, cwd: '/remote', repo: remoteRepo, setup: remoteSetup })
  })
})

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
      error: 'Project is not set up on the selected automation host anymore.'
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
      error: 'Repository for the selected automation host is no longer available.'
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
