import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorktreeCheckoutIdentity } from '../../../../shared/worktree/removal/worktree-checkout-identity'
import type * as WindowsRemoval from './windows-worktree-removal'
import type * as WorkerChild from '../../../worker-thread-child-process/worker-thread-child-process'

const removeWindowsCheckout = vi.hoisted(() => vi.fn())
const canSpawnOnWorkerThread = vi.hoisted(() => vi.fn(() => false))
const gitExecFileAsync = vi.hoisted(() => vi.fn())
const listWorktreesStrict = vi.hoisted(() => vi.fn())
vi.mock('../../command-runner/git-exec-file', () => ({ gitExecFileAsync }))
vi.mock('../catalog/worktree-listing', () => ({ listWorktreesStrict }))
vi.mock('./windows-worktree-removal', async (original) => ({
  ...(await original<typeof WindowsRemoval>()),
  usesNativeWindowsRemoval: () => true,
  removeWindowsCheckout
}))
vi.mock('../../../worker-thread-child-process/worker-thread-child-process', async (original) => ({
  ...(await original<typeof WorkerChild>()),
  canSpawnOnWorkerThread
}))

import { removeWorktree } from './worktree-removal'
import {
  WorktreeRemovalIdentityUnverifiableError,
  isWorktreeRemovalRefused
} from '../../../../shared/worktree/removal/worktree-checkout-identity'
import { failureLeftByGit } from '../../../workspaces/removal/worktree-removal-failure'

afterEach(() => vi.clearAllMocks())

it('retains a failed-removal retry when the worker disappears after the Windows checkout is deleted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-windows-worker-loss-'))
  try {
    canSpawnOnWorkerThread.mockReturnValue(true)
    removeWindowsCheckout.mockImplementationOnce(async () => {
      await rm(root, { recursive: true })
      canSpawnOnWorkerThread.mockReturnValue(false)
    })
    listWorktreesStrict.mockResolvedValueOnce([{ path: root }])
    gitExecFileAsync.mockImplementationOnce(async () => {
      if (!canSpawnOnWorkerThread()) {
        throw new WorktreeRemovalIdentityUnverifiableError()
      }
      return { stdout: '', stderr: '' }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked finalization fails before reading the identity.
    const identity = { root } as unknown as WorktreeCheckoutIdentity
    let failure: unknown
    try {
      await removeWorktree(root, root, false, {
        knownRemovedWorktree: null,
        checkoutDeleteIdentity: identity
      })
    } catch (error) {
      failure = error
    }
    expect(existsSync(root)).toBe(false)
    expect(failure).toBeInstanceOf(Error)
    expect(isWorktreeRemovalRefused(failure)).toBe(false)
    await expect(
      failureLeftByGit(
        {
          worktreeId: 'repo::checkout',
          repoId: 'repo',
          repoPath: root,
          worktreePath: root,
          branch: '',
          head: '',
          deleteBranch: false,
          force: false,
          requestedAt: 1
        },
        failure
      )
    ).resolves.toMatchObject({
      message: 'The checkout was deleted, but Git cleanup could not finish. Retry deletion.'
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
