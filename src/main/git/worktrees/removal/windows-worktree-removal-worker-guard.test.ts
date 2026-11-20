import { expect, it, vi } from 'vitest'
import type { WorktreeCheckoutIdentity } from '../../../../shared/worktree/removal/worktree-checkout-identity'
import type * as WindowsRemoval from './windows-worktree-removal'
import type * as WorkerChild from '../../../worker-thread-child-process/worker-thread-child-process'

const removeWindowsCheckout = vi.hoisted(() => vi.fn())
vi.mock('./windows-worktree-removal', async (original) => ({
  ...(await original<typeof WindowsRemoval>()),
  usesNativeWindowsRemoval: () => true,
  removeWindowsCheckout
}))
vi.mock('../../../worker-thread-child-process/worker-thread-child-process', async (original) => ({
  ...(await original<typeof WorkerChild>()),
  canSpawnOnWorkerThread: () => false
}))

import { removeWorktree } from './worktree-removal'

it('keeps a guarded native Windows checkout when no process worker can check it', async () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: refusal happens before the identity is read.
  const identity = { root: 'C:\\checkout' } as unknown as WorktreeCheckoutIdentity
  await expect(
    removeWorktree('C:\\repo', 'C:\\checkout', false, {
      knownRemovedWorktree: null,
      checkoutDeleteIdentity: identity
    })
  ).rejects.toMatchObject({ code: 'ERR_ORCA_WORKTREE_IDENTITY_UNVERIFIABLE' })
  expect(removeWindowsCheckout).not.toHaveBeenCalled()
})
