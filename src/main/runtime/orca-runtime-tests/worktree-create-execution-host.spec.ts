import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  addWorktree,
  registerSshGitProvider,
  unregisterSshGitProvider
} from '../orca-runtime-test-mocks.spec'
import { store } from '../orca-runtime-test-fixtures.spec'

const RUNTIME_REPO_PATH = '/remote/repo'

function makeRuntimeHostedStore(extraRepoFields: Record<string, unknown> = {}) {
  const repo = {
    ...store.getRepos()[0]!,
    path: RUNTIME_REPO_PATH,
    executionHostId: 'runtime:env-1',
    ...extraRepoFields
  }
  return {
    ...store,
    getRepos: () => [repo],
    getRepo: (id: string) => (id === repo.id ? repo : undefined)
  }
}

describe('OrcaRuntimeService worktree create execution host', () => {
  beforeEach(() => {
    vi.mocked(addWorktree).mockClear()
  })

  it('refuses to create for a runtime-hosted repo with no nested SSH target', async () => {
    const runtime = new OrcaRuntimeService(makeRuntimeHostedStore() as never)

    await expect(
      runtime.createManagedWorktree({ repoSelector: 'id:repo-1', name: 'wt' })
    ).rejects.toThrow('not dispatched by this process')

    expect(addWorktree).not.toHaveBeenCalled()
  })

  it('refuses a runtime-hosted repo whose nested SSH target is dialable in this namespace', async () => {
    // `target-a` names a target inside env-1. The same-named one registered here is another
    // machine, so creating through it would put the checkout on the wrong host.
    const provider = { exec: vi.fn(), addWorktree: vi.fn(), listWorktrees: vi.fn() }
    registerSshGitProvider('target-a', provider as never)
    const runtime = new OrcaRuntimeService(
      makeRuntimeHostedStore({ connectionId: 'target-a' }) as never
    )

    try {
      await expect(
        runtime.createManagedWorktree({ repoSelector: 'id:repo-1', name: 'wt' })
      ).rejects.toThrow('not dispatched by this process')

      expect(provider.addWorktree).not.toHaveBeenCalled()
      expect(addWorktree).not.toHaveBeenCalled()
    } finally {
      unregisterSshGitProvider('target-a')
    }
  })
})
