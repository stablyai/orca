import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearGitCapabilityStateForTests,
  getLocalGitCapabilityCache,
  withLocalGitCapabilityCacheForExecution
} from './git-capability-state'
import { resetWslLinkedWorktreeGitRoutingForTests } from './wsl-linked-worktree-git-routing'

describe('Git capability execution-host state', () => {
  beforeEach(() => {
    clearGitCapabilityStateForTests()
    resetWslLinkedWorktreeGitRoutingForTests()
  })

  it('bounds local capability entries during WSL distro churn', () => {
    const first = getLocalGitCapabilityCache({ wslDistro: 'first-distro' })
    first.rememberUnsupported('worktree-list-z')
    for (let index = 0; index < 132; index += 1) {
      getLocalGitCapabilityCache({ wslDistro: `distro-${index}` })
    }
    expect(
      getLocalGitCapabilityCache({ wslDistro: 'first-distro' }).shouldTry('worktree-list-z')
    ).toBe(true)
  })

  it('starts non-candidate capability work without an added async turn', async () => {
    let started = false
    const result = withLocalGitCapabilityCacheForExecution({ cwd: '/repo' }, async () => {
      started = true
      return 'done'
    })

    expect(started).toBe(true)
    await expect(result).resolves.toBe('done')
  })
})
