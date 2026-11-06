// #36923: a workspace this host runs on a recipe VM over its SSH target is opened through this
// host's own worktree.activate (window, CLI, paired clients), so that opening wakes the VM.
import { describe, expect, it, vi } from 'vitest'

await import('../../orca-runtime-tests/runtime-test-module-registration.spec')
const { OrcaRuntimeService } = await import('../../orca-runtime')
await import('../../orca-runtime-tests/orca-runtime-test-lifecycle.spec')
const { TEST_WINDOW_ID, TEST_WORKTREE_ID, store } =
  await import('../../orca-runtime-tests/orca-runtime-test-fixtures.spec')

describe('activateManagedWorktree and a recipe VM', () => {
  it('wakes the VM behind a workspace this host activates', async () => {
    const resumeVm = vi.fn(async () => null)
    const runtime = new OrcaRuntimeService(store, undefined, {
      workspaceSleepPlatform: {
        callEnvironment: vi.fn(async () => {
          throw new Error('no paired servers')
        }),
        ownsVm: (workspaceId: string) => workspaceId === TEST_WORKTREE_ID,
        acceptWake: () => ({ sshHeld: false, sshUserDisconnects: 0 }),
        suspendVm: vi.fn(async () => {}),
        resumeVm
      }
    })
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)

    await expect(
      runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, {
        notifyClients: false,
        clientKind: 'runtime'
      })
    ).resolves.toMatchObject({ worktreeId: TEST_WORKTREE_ID })
    // The wake runs on its own, since a recipe's resume can outlast activation.
    await vi.waitFor(() =>
      expect(resumeVm).toHaveBeenCalledWith(TEST_WORKTREE_ID, {
        sshHeld: false,
        sshUserDisconnects: 0
      })
    )
  })
})
