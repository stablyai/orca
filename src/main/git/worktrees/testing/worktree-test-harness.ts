import { afterEach, beforeEach, vi } from 'vitest'

import { clearGitCapabilityStateForTests } from '../../command-runner/host-routing/git-capability-state'
import { __resetSparseCheckoutStateCacheForTests } from '../sparse-checkout/worktree-sparse-checkout-cache'

export function registerWorktreeSuiteHooks(): void {
  beforeEach(() => {
    clearGitCapabilityStateForTests()
    __resetSparseCheckoutStateCacheForTests()
    // Remove ambient timeout overrides; undefined matches an absent environment key.
    vi.stubEnv('ORCA_WORKTREE_ADD_TIMEOUT_MS', undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })
}
