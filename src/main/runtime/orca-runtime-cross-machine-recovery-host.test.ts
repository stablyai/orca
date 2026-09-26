import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { registerWorktreeChangeInvalidator } from '../ipc/worktree-change-invalidators'

describe('OrcaRuntimeWithCrossMachineRecoveryHost', () => {
  it('invalidates the renderer worktree listing when recovery refreshes a repo catalog', () => {
    const listingInvalidator = vi.fn()
    const unregister = registerWorktreeChangeInvalidator(listingInvalidator)
    try {
      const host = new OrcaRuntimeService(null).getCrossMachineRecoveryHost(vi.fn())

      host.invalidateWorktreeCatalog('repo-1')

      expect(listingInvalidator).toHaveBeenCalledWith('repo-1')
    } finally {
      unregister()
    }
  })
})
