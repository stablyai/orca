import { afterEach, beforeEach, vi } from 'vitest'

import { clearGitCapabilityStateForTests, getLocalGitCapabilityCache } from './git-capability-state'
import { __resetSparseCheckoutStateCacheForTests } from './worktree-sparse-checkout-cache'

/** Root hooks every worktree suite shares: pristine capability cache, no ambient add-timeout override. */
export function registerWorktreeSuiteHooks(options: { plainWorktreeAdd?: boolean } = {}): void {
  beforeEach(() => {
    clearGitCapabilityStateForTests()
    if (options.plainWorktreeAdd) {
      // Why: these suites queue git replies in order; the split add has its own suite. Ubuntu is the fixtures' WSL distro.
      for (const target of [{}, { wslDistro: 'Ubuntu' }]) {
        getLocalGitCapabilityCache(target).rememberUnsupported('hook-run')
      }
    }
    __resetSparseCheckoutStateCacheForTests()
    // Why: addWorktree reads the override at call time, so a developer's ambient value must not leak in.
    // `undefined` deletes the key, matching production's unset case rather than an empty string.
    vi.stubEnv('ORCA_WORKTREE_ADD_TIMEOUT_MS', undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })
}
