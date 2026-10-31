import { describe, expect, it } from 'vitest'
import { sameGitHubRemoteUrl } from './worktree-push-target-cleanup'

describe('sameGitHubRemoteUrl', () => {
  it.each([
    'git@github.com:contributor/orca.git',
    'ssh://git@ssh.github.com:443/contributor/orca.git'
  ])('matches the supported GitHub transport %s', (ssh) => {
    expect(sameGitHubRemoteUrl(ssh, 'https://github.com/contributor/orca.git')).toBe(true)
  })

  it('is case-insensitive on owner/repo', () => {
    expect(
      sameGitHubRemoteUrl(
        'git@github.com:Contributor/Orca.git',
        'git@github.com:contributor/orca.git'
      )
    ).toBe(true)
  })

  it.each(['git@github.com:someone-else/orca.git', 'https://github.com:8443/contributor/orca.git'])(
    'does not match the different endpoint %s',
    (other) => {
      expect(sameGitHubRemoteUrl('git@github.com:contributor/orca.git', other)).toBe(false)
    }
  )

  it('falls back to exact equality for non-GitHub hosts', () => {
    expect(
      sameGitHubRemoteUrl(
        'git@gitlab.com:contributor/orca.git',
        'git@gitlab.com:contributor/orca.git'
      )
    ).toBe(true)
    expect(
      sameGitHubRemoteUrl(
        'git@gitlab.com:contributor/orca.git',
        'https://gitlab.com/contributor/orca.git'
      )
    ).toBe(false)
  })
})
