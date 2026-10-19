import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  RuntimeBrowserCommands,
  setRuntimeBrowserCommandsFactory,
  setRuntimeBrowserUnavailableCause
} from '../orca-runtime-test-mocks.spec'
import { runtimeAdvertisesBrowserClientHosting } from '../../../shared/browser-client-hosting-eligibility'
import {
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  createRuntime,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('rejects a qualified removal when only another host has persisted ownership', async () => {
    const runtimeStore = {
      ...store,
      getWorktreeMeta: () => ({ ...store.getWorktreeMeta(TEST_WORKTREE_ID), hostId: 'local' })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const internals = runtime as unknown as {
      listResolvedWorktrees: () => Promise<unknown[]>
      resolveWorktreeRemovalTarget: (
        worktreeSelector: string,
        requiredHostId?: string
      ) => Promise<unknown>
    }
    internals.listResolvedWorktrees = vi.fn().mockResolvedValue([
      {
        id: TEST_WORKTREE_ID,
        repoId: TEST_REPO_ID,
        path: TEST_WORKTREE_PATH,
        hostId: 'local'
      }
    ])

    await expect(
      internals.resolveWorktreeRemovalTarget(TEST_WORKTREE_ID, 'runtime:env-b')
    ).rejects.toThrow('selector_not_found')
    expect(internals.listResolvedWorktrees).not.toHaveBeenCalled()
  })

  // #30731: orcad with no engine still hosts pages on a paired desktop, and says why it can't itself.
  it('advertises client hosting from an engine-free factory while reporting the engine cause', () => {
    setRuntimeBrowserCommandsFactory((host) => new RuntimeBrowserCommands(host), {
      headless: true,
      clientHostingWithoutEngine: true,
      isAvailable: () => false
    })
    setRuntimeBrowserUnavailableCause({ reason: 'unconfigured' })
    const status = createRuntime().getStatus()
    expect(runtimeAdvertisesBrowserClientHosting(status.capabilities)).toBe(true)
    expect(status.capabilities).toContain('browser.tab-create-known-id.v1')
    expect(status.capabilities).not.toContain('browser.headless.v1')
    expect(status.degradations).toContainEqual(
      expect.objectContaining({ code: 'browser_unavailable', reason: 'unconfigured' })
    )
    setRuntimeBrowserUnavailableCause(null)
  })
})
