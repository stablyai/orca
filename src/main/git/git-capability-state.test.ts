import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearGitCapabilityStateForTests,
  getLocalGitCapabilityCache,
  getSshGitCapabilityCache,
  LOCAL_GIT_CAPABILITY_HOST_KEY_MAX_BYTES,
  LOCAL_GIT_CAPABILITY_HOST_MAX_ENTRIES
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

  it('evicts the oldest local execution host after the host ceiling', () => {
    const oldest = getLocalGitCapabilityCache({ wslDistro: 'Distro-0' })
    let newest = oldest
    for (let index = 1; index <= LOCAL_GIT_CAPABILITY_HOST_MAX_ENTRIES; index++) {
      newest = getLocalGitCapabilityCache({ wslDistro: `Distro-${index}` })
    }

    expect(getLocalGitCapabilityCache({ wslDistro: 'Distro-0' })).not.toBe(oldest)
    expect(
      getLocalGitCapabilityCache({
        wslDistro: `Distro-${LOCAL_GIT_CAPABILITY_HOST_MAX_ENTRIES}`
      })
    ).toBe(newest)
  })

  it('does not retain oversized execution-host keys', () => {
    const oversizedDistro = 'x'.repeat(LOCAL_GIT_CAPABILITY_HOST_KEY_MAX_BYTES + 1)

    expect(getLocalGitCapabilityCache({ wslDistro: oversizedDistro })).not.toBe(
      getLocalGitCapabilityCache({ wslDistro: oversizedDistro })
    )
  })
})
