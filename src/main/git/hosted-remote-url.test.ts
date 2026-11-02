import { describe, expect, it } from 'vitest'
import { buildHostedRemoteFileUrl, parseHostedRemote } from './hosted-remote-url'

describe('hosted remote URLs', () => {
  it('builds file URLs with encoded branches and paths', () => {
    expect(
      buildHostedRemoteFileUrl(
        'ssh://git@altssh.gitlab.com:443/team/project.git',
        'src/a file.ts',
        'feature/x',
        5
      )
    ).toBe('https://gitlab.com/team/project/-/blob/feature%2Fx/src/a%20file.ts#L5')
    expect(
      buildHostedRemoteFileUrl('git@github.com:Org/Repo.git', 'src/a file.ts', 'feature/x', 42, 45)
    ).toBe('https://github.com/Org/Repo/blob/feature%2Fx/src/a%20file.ts#L42-L45')

    expect(
      buildHostedRemoteFileUrl('git@gitlab.com:group/sub/repo.git', 'src/a.ts', 'feature/x', 9, 12)
    ).toBe('https://gitlab.com/group/sub/repo/-/blob/feature%2Fx/src/a.ts#L9-12')

    expect(
      buildHostedRemoteFileUrl('git@bitbucket.org:team/repo.git', 'src/a.ts', 'feature/x', 7, 10)
    ).toBe('https://bitbucket.org/team/repo/src/feature%2Fx/src/a.ts#a.ts-7:10')

    expect(
      buildHostedRemoteFileUrl(
        'ssh://git@ssh.github.com:443/Org/Repo.git',
        'src/a.ts',
        'feature/x',
        5
      )
    ).toBe('https://github.com/Org/Repo/blob/feature%2Fx/src/a.ts#L5')
    expect(
      buildHostedRemoteFileUrl('git@ssh.bitbucket.org:team/repo.git', 'src/a.ts', 'feature/x', 5)
    ).toBe('https://bitbucket.org/team/repo/src/feature%2Fx/src/a.ts#a.ts-5')
  })

  it('rejects unsupported hosts and incomplete repo paths', () => {
    expect(parseHostedRemote('git@example.com:team/repo.git')).toBeNull()
    expect(parseHostedRemote('git@github.com:repo.git')).toBeNull()
    expect(parseHostedRemote('ftp://github.com/Org/Repo.git')).toBeNull()
    expect(parseHostedRemote('git@ssh.bitbucket.org.example.com:team/repo.git')).toBeNull()
    expect(parseHostedRemote('ssh://git@ssh.bitbucket.org.example.com/team/repo.git')).toBeNull()
    expect(parseHostedRemote('git@notssh.bitbucket.org:team/repo.git')).toBeNull()
    expect(parseHostedRemote('git@altssh.gitlab.com.example.com:team/repo.git')).toBeNull()
    expect(parseHostedRemote('ssh://git@altssh.gitlab.com.example.com/team/repo.git')).toBeNull()
    expect(parseHostedRemote('git@notaltssh.gitlab.com:team/repo.git')).toBeNull()
  })
})
