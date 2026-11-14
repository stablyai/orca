import { describe, expect, it, vi } from 'vitest'
import '../orca-runtime-tests/orca-runtime-test-lifecycle.spec'
import '../orca-runtime-tests/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { listWorktrees } from '../../git/worktrees/catalog/worktree-scan-cache'
import {
  TEST_REPO_ID,
  TEST_REPO_PATH,
  makeWorktreeInfo,
  store
} from '../orca-runtime-tests/orca-runtime-test-fixtures.spec'
import type { Repo } from '../../../shared/repo-types'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'

const externalPath = '/tmp/elsewhere/external'

async function createScannedRuntime() {
  let repo: Repo = { ...store.getRepos()[0], externalWorktreeVisibility: 'hide' }
  const runtime = new OrcaRuntimeService({
    ...store,
    getRepo: (id: string) => (id === repo.id ? repo : undefined),
    getRepos: () => [repo],
    updateRepo: (_target: Repo, updates: Partial<Repo>) => {
      repo = { ...repo, ...updates }
      return repo
    }
  })
  vi.mocked(listWorktrees).mockClear()
  vi.mocked(listWorktrees).mockResolvedValue([
    makeWorktreeInfo(TEST_REPO_PATH),
    makeWorktreeInfo(externalPath)
  ])
  const events: RuntimeClientEvent[] = []
  runtime.onClientEvent((event) => events.push(event))
  const isExternalVisible = async () =>
    (await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)).worktrees.find(
      (worktree) => worktree.path === externalPath
    )?.visible
  expect(await isExternalVisible()).toBe(false)
  return { runtime, events, isExternalVisible }
}

describe('repo.update worktree refresh', () => {
  it('re-lists a newly shown external worktree without rescanning Git', async () => {
    const { runtime, events, isExternalVisible } = await createScannedRuntime()

    await runtime.updateRepo(`id:${TEST_REPO_ID}`, { externalWorktreeVisibility: 'show' })

    expect(events).toContainEqual({ type: 'worktreesChanged', repoId: TEST_REPO_ID })
    expect(await isExternalVisible()).toBe(true)
    expect(listWorktrees).toHaveBeenCalledTimes(1)
  })
})
