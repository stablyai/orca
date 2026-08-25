import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearGitCapabilityStateForTests,
  getLocalGitCapabilityCache,
  getSshGitCapabilityCache,
  withLocalGitCapabilityCacheForExecution
} from './git-capability-state'
import {
  resetWslLinkedWorktreeGitRoutingForTests,
  seedWslLinkedWorktreeGitRoutingForTests
} from './wsl-linked-worktree-git-routing'

describe('Git capability execution-host state', () => {
  beforeEach(() => {
    clearGitCapabilityStateForTests()
    resetWslLinkedWorktreeGitRoutingForTests()
  })

  it('shares native state while isolating each WSL distro', () => {
    expect(getLocalGitCapabilityCache({ cwd: '/repo-a' })).toBe(
      getLocalGitCapabilityCache({ cwd: '/repo-b' })
    )
    expect(getLocalGitCapabilityCache({ wslDistro: 'Ubuntu' })).toBe(
      getLocalGitCapabilityCache({ cwd: '\\\\wsl.localhost\\Ubuntu\\home\\repo' })
    )
    expect(getLocalGitCapabilityCache({ wslDistro: 'Ubuntu' })).not.toBe(
      getLocalGitCapabilityCache({ wslDistro: 'Debian' })
    )
    expect(getLocalGitCapabilityCache()).not.toBe(
      getLocalGitCapabilityCache({ wslDistro: 'Ubuntu' })
    )
  })

  // A stale hint used to rename the host, filing results from the distro that ran
  // git against one that never did.
  it('files state against the distro in the cwd, not a hint naming another one', () => {
    const cwd = String.raw`\\wsl.localhost\Ubuntu\home\user\repo`

    expect(getLocalGitCapabilityCache({ cwd, wslDistro: 'Debian' })).toBe(
      getLocalGitCapabilityCache({ cwd })
    )
    expect(getLocalGitCapabilityCache({ cwd, wslDistro: 'Debian' })).not.toBe(
      getLocalGitCapabilityCache({ wslDistro: 'Debian' })
    )
  })

  // Windows folds distro case, so two spellings of one distro sharing a cache is
  // the difference between probing every capability once and probing it twice.
  it('shares one cache across both UNC spellings of a distro', () => {
    expect(
      getLocalGitCapabilityCache({ cwd: String.raw`\\wsl.localhost\Ubuntu\home\u\repo` })
    ).toBe(getLocalGitCapabilityCache({ cwd: String.raw`\\wsl$\ubuntu\home\u\other` }))
  })

  it('shares one SSH provider lifetime without leaking into a replacement provider', () => {
    const provider = {}
    const replacementProvider = {}

    expect(getSshGitCapabilityCache(provider)).toBe(getSshGitCapabilityCache(provider))
    expect(getSshGitCapabilityCache(provider)).not.toBe(
      getSshGitCapabilityCache(replacementProvider)
    )
  })

  it('uses native capability state for a prepared host-routed WSL worktree', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      seedWslLinkedWorktreeGitRoutingForTests(String.raw`C:\repo\linked`)

      await expect(
        withLocalGitCapabilityCacheForExecution(
          { cwd: String.raw`C:\repo\linked`, wslDistro: 'Ubuntu' },
          async (capabilities) => capabilities
        )
      ).resolves.toBe(getLocalGitCapabilityCache())
      expect(getLocalGitCapabilityCache()).not.toBe(
        getLocalGitCapabilityCache({ wslDistro: 'Ubuntu' })
      )
    } finally {
      platform.mockRestore()
    }
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
