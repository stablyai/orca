import { describe, expect, it } from 'vitest'
import type { Automation } from '../../shared/automations-types'
import type { ProjectHostSetup, Repo } from '../../shared/types'
import type { Store } from '../persistence'
import { resolveAutomationRunTarget } from './run-target-resolution'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 1,
    ...overrides
  }
}

function makeSetup(overrides: Partial<ProjectHostSetup> = {}): ProjectHostSetup {
  return {
    id: 'shared-setup',
    projectId: 'project-1',
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

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
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
    workspaceId: null,
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
    ...overrides
  }
}

describe('resolveAutomationRunTarget', () => {
  it('matches repeated setup ids by the saved host context', () => {
    const localRepo = makeRepo({ path: '/local/repo' })
    const runtimeRepo = makeRepo({ path: '/runtime/repo', executionHostId: 'runtime:gpu' })
    const store = {
      getProjectHostSetups: () => [
        makeSetup({ hostId: 'local', path: '/local/repo' }),
        makeSetup({ hostId: 'runtime:gpu', path: '/runtime/repo' })
      ],
      getRepos: () => [localRepo, runtimeRepo]
    } as Store
    const automation = makeAutomation({
      schedulerOwner: 'remote_host_service',
      runContext: {
        kind: 'workspace-run',
        projectId: 'project-1',
        hostId: 'runtime:gpu',
        projectHostSetupId: 'shared-setup',
        repoId: 'repo-1',
        path: '/runtime/repo'
      }
    })

    expect(
      resolveAutomationRunTarget(store, automation, { allowRemoteHostScheduling: true })
    ).toMatchObject({
      ok: true,
      cwd: '/runtime/repo',
      repo: runtimeRepo,
      setup: expect.objectContaining({ hostId: 'runtime:gpu' })
    })
  })
})
