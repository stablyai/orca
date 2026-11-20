import { describe, expect, it } from 'vitest'
import { matchRemoteToGiteaLogin, remoteMatchesInstanceUrl } from './gitea-login-remote-match'

const LOGIN = {
  name: 'ada@git.example.com',
  url: 'https://git.example.com',
  host: 'git.example.com',
  sshHost: 'git.example.com:2222',
  user: 'ada',
  isDefault: true
}

describe('matchRemoteToGiteaLogin', () => {
  it('matches an https remote on the login host', () => {
    expect(matchRemoteToGiteaLogin('https://git.example.com/team/app.git', LOGIN)).toEqual({
      host: 'git.example.com',
      owner: 'team',
      repo: 'app',
      apiBaseUrl: 'https://git.example.com/api/v1',
      webBaseUrl: 'https://git.example.com',
      loginName: 'ada@git.example.com'
    })
  })

  it('matches an ssh url on the login ssh port and rejects another port', () => {
    expect(
      matchRemoteToGiteaLogin('ssh://git@git.example.com:2222/team/app.git', LOGIN)?.repo
    ).toBe('app')
    expect(matchRemoteToGiteaLogin('ssh://git@git.example.com:22/team/app.git', LOGIN)).toBeNull()
  })

  it('matches an scp-like remote', () => {
    expect(matchRemoteToGiteaLogin('git@git.example.com:team/app.git', LOGIN)?.owner).toBe('team')
  })

  it('keeps a subpath install and rejects remotes outside it', () => {
    const subpath = { ...LOGIN, url: 'https://example.com/gitea', host: 'example.com/gitea' }
    expect(matchRemoteToGiteaLogin('https://example.com/gitea/team/app', subpath)?.apiBaseUrl).toBe(
      'https://example.com/gitea/api/v1'
    )
    expect(matchRemoteToGiteaLogin('https://example.com/team/app', subpath)).toBeNull()
  })

  it('rejects a different host', () => {
    expect(matchRemoteToGiteaLogin('https://github.com/team/app.git', LOGIN)).toBeNull()
  })
})

describe('remoteMatchesInstanceUrl', () => {
  it('compares the scheme and host for http remotes and the host for ssh remotes', () => {
    expect(remoteMatchesInstanceUrl('https://git.example.com/a/b', 'https://git.example.com')).toBe(
      true
    )
    expect(remoteMatchesInstanceUrl('http://git.example.com/a/b', 'https://git.example.com')).toBe(
      false
    )
    expect(remoteMatchesInstanceUrl('git@git.example.com:a/b.git', 'https://git.example.com')).toBe(
      true
    )
  })
})
