import { describe, expect, it } from 'vitest'
import { buildHostedRemoteFileUrl, parseHostedRemote } from './hosted-remote-url'

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
    ).toBe('https://gitlab.com/group/sub/repo/tree/feature%2Fx/src/a.ts#L9')

    expect(
      buildHostedRemoteFileUrl('git@bitbucket.org:team/repo.git', 'src/a.ts', 'feature/x', 7)
    ).toBe('https://bitbucket.org/team/repo/src/feature%2Fx/src/a.ts#L7')
  })

  it('rejects unsupported hosts and incomplete repo paths', () => {
    expect(parseHostedRemote('git@example.com:team/repo.git')).toBeNull()
    expect(parseHostedRemote('git@github.com:repo.git')).toBeNull()
    expect(parseHostedRemote('ftp://github.com/Org/Repo.git')).toBeNull()
  })
})
