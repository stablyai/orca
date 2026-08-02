import { describe, expect, it } from 'vitest'
import {
  buildHostedRemoteCommitUrl,
  buildHostedRemoteFileUrl,
  parseHostedRemote
} from './hosted-remote-url'

describe('hosted remote URLs', () => {
  it('parses common GitHub remote formats', () => {
    expect(parseHostedRemote('https://github.com/Org/Repo.git')).toEqual({
      host: 'github.com',
      path: 'Org/Repo',
      provider: 'github'
    })
    expect(parseHostedRemote('git@github.com:Org/Repo.git')).toEqual({
      host: 'github.com',
      path: 'Org/Repo',
      provider: 'github'
    })
    expect(parseHostedRemote('ssh://git@github.com/Org/Repo.git')).toEqual({
      host: 'github.com',
      path: 'Org/Repo',
      provider: 'github'
    })
    expect(parseHostedRemote('ssh://git@ssh.github.com:443/Org/Repo.git')).toEqual({
      host: 'github.com',
      path: 'Org/Repo',
      provider: 'github'
    })
    expect(parseHostedRemote('github:Org/Repo')).toEqual({
      host: 'github.com',
      path: 'Org/Repo',
      provider: 'github'
    })
  })

  it('parses nested GitLab and Bitbucket remotes', () => {
    expect(parseHostedRemote('git@gitlab.com:group/sub/repo.git')).toEqual({
      host: 'gitlab.com',
      path: 'group/sub/repo',
      provider: 'gitlab'
    })
    expect(parseHostedRemote('https://bitbucket.org/team/repo.git')).toEqual({
      host: 'bitbucket.org',
      path: 'team/repo',
      provider: 'bitbucket'
    })
  })

  it('builds file URLs with encoded branches and paths', () => {
    expect(
      buildHostedRemoteFileUrl('git@github.com:Org/Repo.git', 'src/a file.ts', 'feature/x', 42)
    ).toBe('https://github.com/Org/Repo/blob/feature%2Fx/src/a%20file.ts#L42')

    expect(
      buildHostedRemoteFileUrl('git@gitlab.com:group/sub/repo.git', 'src/a.ts', 'feature/x', 9)
    ).toBe('https://gitlab.com/group/sub/repo/-/blob/feature%2Fx/src/a.ts#L9')

    expect(
      buildHostedRemoteFileUrl('git@bitbucket.org:team/repo.git', 'src/a.ts', 'feature/x', 7)
    ).toBe('https://bitbucket.org/team/repo/src/feature%2Fx/src/a.ts#a.ts-7')

    expect(
      buildHostedRemoteFileUrl(
        'ssh://git@ssh.github.com:443/Org/Repo.git',
        'src/a.ts',
        'feature/x',
        5
      )
    ).toBe('https://github.com/Org/Repo/blob/feature%2Fx/src/a.ts#L5')
  })

  it('builds Bitbucket line fragments from the target file name', () => {
    expect(
      buildHostedRemoteFileUrl('https://bitbucket.org/team/repo.git', 'src/a file.ts', 'main', 29)
    ).toBe('https://bitbucket.org/team/repo/src/main/src/a%20file.ts#a%20file.ts-29')
  })

  it('builds commit URLs per provider from ssh and https remotes', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567'
    expect(buildHostedRemoteCommitUrl('git@github.com:Org/Repo.git', sha)).toBe(
      `https://github.com/Org/Repo/commit/${sha}`
    )
    expect(buildHostedRemoteCommitUrl('https://gitlab.com/group/sub/repo.git', sha)).toBe(
      `https://gitlab.com/group/sub/repo/-/commit/${sha}`
    )
    expect(buildHostedRemoteCommitUrl('git@bitbucket.org:team/repo.git', sha)).toBe(
      `https://bitbucket.org/team/repo/commits/${sha}`
    )
  })

  it('returns null for unsupported commit remotes or missing sha', () => {
    expect(
      buildHostedRemoteCommitUrl(
        'git@example.com:team/repo.git',
        '0123456789abcdef0123456789abcdef01234567'
      )
    ).toBeNull()
    expect(buildHostedRemoteCommitUrl('git@github.com:Org/Repo.git', '')).toBeNull()
  })

  it('rejects unsupported hosts and incomplete repo paths', () => {
    expect(parseHostedRemote('git@example.com:team/repo.git')).toBeNull()
    expect(parseHostedRemote('git@github.com:repo.git')).toBeNull()
    expect(parseHostedRemote('ftp://github.com/Org/Repo.git')).toBeNull()
  })
})
