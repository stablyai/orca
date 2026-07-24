import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  gitExecFileSync: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileSync: mocks.gitExecFileSync,
  gitExecFileAsync: vi.fn()
}))

import { getRemoteCommitFileUrl } from './repo'

const SHA = '0123456789abcdef0123456789abcdef01234567'

describe('getRemoteCommitFileUrl', () => {
  beforeEach(() => {
    mocks.gitExecFileSync.mockReset()
  })

  it('reads origin with the owning WSL distro and builds a snapshot URL', () => {
    mocks.gitExecFileSync.mockImplementation((args: string[]) =>
      args[0] === 'remote' ? 'git@github.com:Org/Repo.git\n' : 'refs/remotes/origin/main\n'
    )

    expect(
      getRemoteCommitFileUrl('/repo', 'src/a file.ts', SHA, { wslDistro: 'Ubuntu-24.04' })
    ).toEqual({
      status: 'ok',
      url: `https://github.com/Org/Repo/blob/${SHA}/src/a%20file.ts`
    })
    expect(mocks.gitExecFileSync).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
      cwd: '/repo',
      wslDistro: 'Ubuntu-24.04'
    })
    expect(mocks.gitExecFileSync).toHaveBeenCalledWith(
      ['for-each-ref', '--format=%(refname)', '--contains', SHA, 'refs/remotes/origin'],
      { cwd: '/repo', wslDistro: 'Ubuntu-24.04' }
    )
  })

  it('returns no-remote when origin cannot be read', () => {
    mocks.gitExecFileSync.mockImplementation(() => {
      throw new Error('missing origin')
    })

    expect(getRemoteCommitFileUrl('/repo', 'src/a.ts', SHA)).toEqual({ status: 'no-remote' })
  })

  it('returns no-remote for unsupported hosts without probing containment', () => {
    mocks.gitExecFileSync.mockReturnValue('git@example.com:team/repo.git\n')

    expect(getRemoteCommitFileUrl('/repo', 'src/a.ts', SHA)).toEqual({ status: 'no-remote' })
    expect(mocks.gitExecFileSync).toHaveBeenCalledTimes(1)
  })

  it('returns commit-not-on-remote when no origin ref contains the commit', () => {
    mocks.gitExecFileSync.mockImplementation((args: string[]) =>
      args[0] === 'remote' ? 'git@github.com:Org/Repo.git\n' : ''
    )

    expect(getRemoteCommitFileUrl('/repo', 'src/a.ts', SHA)).toEqual({
      status: 'commit-not-on-remote'
    })
  })

  it('keeps the resolved URL when the containment probe fails', () => {
    mocks.gitExecFileSync.mockImplementation((args: string[]) => {
      if (args[0] === 'remote') {
        return 'git@github.com:Org/Repo.git\n'
      }
      throw new Error('for-each-ref failed')
    })

    expect(getRemoteCommitFileUrl('/repo', 'src/a.ts', SHA)).toEqual({
      status: 'ok',
      url: `https://github.com/Org/Repo/blob/${SHA}/src/a.ts`
    })
  })
})
