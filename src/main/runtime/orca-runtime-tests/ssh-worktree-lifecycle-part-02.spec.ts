import { describe, expect, it, vi } from 'vitest'

import {
  OrcaRuntimeService,
  getEffectiveHooks,
  hasHooksFile,
  loadHooks,
  removeWorktree
} from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_REPO_PATH,
  store,
  syncSinglePty
} from '../orca-runtime-test-fixtures.spec'

// Connected SSH fixtures need the host HOME for removal guards.

describe('OrcaRuntimeService', () => {
  // Without an SSH PTY provider, deletion must refuse rather than sweep a same-id local workspace.
  it('refuses an SSH delete without stopping a same-id local terminal', async () => {
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const remoteStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: () => remoteRepo
    }
    const runtime = new OrcaRuntimeService(remoteStore as never)
    const stopAndWait = vi.fn(async () => true)
    runtime.setPtyController({
      write: () => true,
      kill: vi.fn(() => true),
      stopAndWait,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, null)
    runtime.registerPty('pty-remote', `${TEST_REPO_ID}::/remote/feature`, 'ssh-1')
    runtime.registerPty('pty-local-same-id', `${TEST_REPO_ID}::/remote/feature`, null)

    await expect(
      runtime.removeManagedWorktree('path:/remote/feature', {
        force: true,
        runHooks: false
      })
    ).rejects.toThrow()

    expect(stopAndWait).not.toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('reports SSH repo hooks as absent without reading this machine', async () => {
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: 'C:/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ]
    }
    const runtime = new OrcaRuntimeService(remoteStore as never)

    await expect(runtime.getRepoHooks('id:repo-1')).resolves.toMatchObject({
      hasHooksFile: false,
      hooks: null,
      source: null
    })
    expect(hasHooksFile).not.toHaveBeenCalled()
    expect(getEffectiveHooks).not.toHaveBeenCalled()
  })

  it('hashes only the shared orca.yaml setup script for local run-both hooks', async () => {
    vi.mocked(hasHooksFile).mockReturnValue(true)
    vi.mocked(loadHooks).mockReturnValue({ scripts: { setup: 'echo yaml setup' } })
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: { setup: 'echo yaml setup\necho local setup' }
    })
    const runtimeStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: TEST_REPO_PATH,
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          hookSettings: {
            commandSourcePolicy: 'run-both' as const,
            scripts: { setup: 'echo local setup' }
          }
        }
      ]
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(runtime.getRepoHooks('id:repo-1')).resolves.toMatchObject({
      hooks: { scripts: { setup: 'echo yaml setup\necho local setup' } },
      setupTrust: {
        contentHash: '9bc9f57699fe0390d263cca1aec01235cccc8fa5fc87cd87fd51ba1c8483ec84',
        scriptContent: 'echo yaml setup'
      }
    })
  })
})
