import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { WorkerPlacementCatalogOwner } from './worker-placement-catalog-owner'
import * as resolution from '../../../../workspaces/execution-host/local-project-runtime-resolution'
import { projectSetupsWithWorkerExecutionTargets } from './worker-execution-target'
import {
  partialRuntimeStore,
  storeProject,
  storeRepo
} from '../../../construction/test-context/runtime-store-partial-fixture'
import type { ProjectHostSetup } from '../../../../../shared/project/project-types'
import type { OrchestrationEnvironmentTransport } from '../environment-transport'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// #45148: overlapping discovery and unresponsive peers must not multiply reads or catalog scans.
it('shares one list pair per server across concurrent discoveries and keeps timed-out work in its slot', async () => {
  vi.useFakeTimers()
  const db = new OrchestrationDb(':memory:')
  const call = vi.fn<OrchestrationEnvironmentTransport['call']>(() => new Promise(() => {}))
  const owner = new WorkerPlacementCatalogOwner(db, {
    list: async () => [{ environmentId: 'server', name: 'server' }],
    resolve: async () => ({
      environmentId: 'server',
      name: 'server',
      peerFingerprint: 'peer',
      homePeerFingerprint: 'home',
      pairingRevision: 1
    }),
    call
  })
  try {
    const discoveries = [owner.discover(), owner.discover(), owner.discover()]
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await Promise.all(discoveries)).map((answer) => answer[0].status)).toEqual([
      'unchecked',
      'unchecked',
      'unchecked'
    ])
    expect(call).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(15_000)
    expect((await owner.discover())[0].status).toBe('unchecked')
    expect(call).toHaveBeenCalledTimes(2)
  } finally {
    db.close()
  }
})

it('indexes a full-size shared project once and resolves a shared worktree scope once', () => {
  const resolve = vi.spyOn(resolution, 'resolveLocalWorkspaceRuntime')
  const repos = Array.from({ length: 5_000 }, (_, index) =>
    storeRepo({ id: `repo-${index}`, path: `/repo/${index}` })
  )
  const getProjects = vi.fn(() => [
    storeProject({ id: 'project', sourceRepoIds: repos.map((repo) => repo.id) })
  ])
  const getSettings = vi.fn(() => ({
    workspaceDir: '\\\\wsl.localhost\\Ubuntu\\worktrees',
    nestWorkspaces: false
  }))
  const store = partialRuntimeStore({ getProjects, getSettings })
  const setups: ProjectHostSetup[] = repos.map((repo) => ({
    id: `setup-${repo.id}`,
    projectId: 'project',
    repoId: repo.id,
    hostId: 'local',
    path: repo.path,
    displayName: repo.id,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  }))
  expect(projectSetupsWithWorkerExecutionTargets(store, repos, setups)).toHaveLength(5_000)
  expect(getProjects).toHaveBeenCalledTimes(1)
  expect(getSettings).toHaveBeenCalledTimes(1)
  expect(resolve).toHaveBeenCalledTimes(1)
})
