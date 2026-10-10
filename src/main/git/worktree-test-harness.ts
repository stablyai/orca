import { afterEach, beforeEach, vi } from 'vitest'

import { clearGitCapabilityStateForTests } from './git-capability-state'
import { __resetSparseCheckoutStateCacheForTests } from './worktree-sparse-checkout-cache'

/** Root hooks every worktree suite shares: pristine capability cache, no ambient add-timeout override. */
export function registerWorktreeSuiteHooks(): void {
  beforeEach(() => {
    clearGitCapabilityStateForTests()
    __resetSparseCheckoutStateCacheForTests()
    // Why: addWorktree reads the override at call time, so a developer's ambient value must not leak in.
    // `undefined` deletes the key, matching production's unset case rather than an empty string.
    vi.stubEnv('ORCA_WORKTREE_ADD_TIMEOUT_MS', undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })
}
