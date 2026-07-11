import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearGitCapabilityStateForTests,
  getLocalGitCapabilityCache,
  getSshGitCapabilityCache
} from './git-capability-state'

describe('Git capability execution-host state', () => {
  beforeEach(() => {
    clearGitCapabilityStateForTests()
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

  it('shares one SSH provider lifetime without leaking into a replacement provider', () => {
    const provider = {}
    const replacementProvider = {}

    expect(getSshGitCapabilityCache(provider)).toBe(getSshGitCapabilityCache(provider))
    expect(getSshGitCapabilityCache(provider)).not.toBe(
      getSshGitCapabilityCache(replacementProvider)
    )
  })
})
