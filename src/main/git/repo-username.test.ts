import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChildProcess from 'node:child_process'
import type * as RepoModule from './repo'

const execSyncMock = vi.hoisted(() => vi.fn())
const execFileSyncMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof ChildProcess>('child_process')
  return {
    ...actual,
    execSync: execSyncMock,
    execFileSync: execFileSyncMock
  }
})

describe('getGitUsername', () => {
  let gitConfig: Record<string, string>
  let originRemoteUrl: string | undefined
  let remoteUrls: Record<string, string>
  let getGitUsername: typeof RepoModule.getGitUsername

  beforeEach(async () => {
    vi.resetModules()
    execSyncMock.mockReset()
    execFileSyncMock.mockReset()
    gitConfig = {}
    originRemoteUrl = undefined
    remoteUrls = {}

    execFileSyncMock.mockImplementation((_binary: string, args: string[]) => {
      if (args[0] === 'config' && args[1] === '--get') {
        const value = gitConfig[args[2]]
        if (value !== undefined) {
          return `${value}\n`
        }
        throw new Error(`missing config ${args[2]}`)
      }
      if (args[0] === 'remote' && args.length === 1) {
        const remotes = new Set(Object.keys(remoteUrls))
        if (originRemoteUrl) {
          remotes.add('origin')
        }
        return `${[...remotes].join('\n')}\n`
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        const remoteUrl = args[2] === 'origin' ? originRemoteUrl : remoteUrls[args[2]]
        if (remoteUrl) {
          return `${remoteUrl}\n`
        }
        throw new Error(`missing ${args[2]} remote`)
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    ;({ getGitUsername } = await import('./repo'))
  })

  it('prefers explicit GitHub user config before checking GitHub CLI login', () => {
    originRemoteUrl = 'https://github.com/stablyai/orca.git'
    gitConfig['github.user'] = 'config-demo'
    execSyncMock.mockImplementationOnce(() => 'gh-demo\n')

    expect(getGitUsername('/repo')).toBe('config-demo')
    expect(execSyncMock).not.toHaveBeenCalled()
  })

  it('uses explicit username config before checking GitHub CLI login', () => {
    originRemoteUrl = 'https://github.com/stablyai/orca.git'
    gitConfig['user.username'] = 'repo-demo'
    execSyncMock.mockImplementationOnce(() => 'gh-demo\n')

    expect(getGitUsername('/repo')).toBe('repo-demo')
    expect(execSyncMock).not.toHaveBeenCalled()
  })

  it('uses GitHub CLI login for GitHub remotes instead of repo-local author identity', () => {
    originRemoteUrl = 'https://github.com/stablyai/orca.git'
    gitConfig['user.email'] = 'demo@example.com'
    gitConfig['user.name'] = 'Demo User'
    execSyncMock.mockImplementationOnce(() => 'gh-demo\n')

    expect(getGitUsername('/repo')).toBe('gh-demo')
    expect(execSyncMock).toHaveBeenCalledTimes(1)
  })

  it('uses GitHub CLI login for a single GitHub remote not named origin', () => {
    remoteUrls.upstream = 'https://github.com/stablyai/orca.git'
    execSyncMock.mockImplementationOnce(() => 'gh-demo\n')

    expect(getGitUsername('/repo')).toBe('gh-demo')
    expect(execFileSyncMock.mock.calls).toEqual(
      expect.arrayContaining([
        ['git', ['remote', 'get-url', 'upstream'], expect.objectContaining({ cwd: '/repo' })]
      ])
    )
    expect(execSyncMock).toHaveBeenCalledTimes(1)
  })

  it('uses GitHub CLI login for GitHub SSH-over-443 remotes', () => {
    remoteUrls.upstream = 'ssh://git@ssh.github.com:443/stablyai/orca.git'
    execSyncMock.mockImplementationOnce(() => 'gh-demo\n')

    expect(getGitUsername('/repo')).toBe('gh-demo')
    expect(execSyncMock).toHaveBeenCalledTimes(1)
  })

  it('does not derive GitHub username prefixes from non-GitHub author identity', () => {
    originRemoteUrl = 'https://gitlab.com/stablyai/orca.git'
    gitConfig['user.email'] = 'demo@example.com'
    gitConfig['user.name'] = 'Demo User'
    execSyncMock.mockImplementationOnce(() => 'gh-demo\n')

    expect(getGitUsername('/repo')).toBe('')
    expect(execSyncMock).not.toHaveBeenCalled()
  })

  it('bounds and caches failed GitHub CLI lookup', () => {
    originRemoteUrl = 'https://github.com/stablyai/orca.git'
    execSyncMock.mockImplementation(() => {
      throw new Error('gh unavailable')
    })

    expect(getGitUsername('/repo')).toBe('')
    expect(getGitUsername('/repo')).toBe('')

    expect(execSyncMock).toHaveBeenCalledTimes(2)
    for (const [, options] of execSyncMock.mock.calls) {
      expect(options).toMatchObject({ timeout: 2500 })
    }
  })

  it('skips auth status fallback when GitHub CLI API lookup times out', () => {
    originRemoteUrl = 'https://github.com/stablyai/orca.git'
    execSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('spawnSync /bin/sh ETIMEDOUT'), { code: 'ETIMEDOUT' })
    })

    expect(getGitUsername('/repo')).toBe('')
    expect(getGitUsername('/repo')).toBe('')

    expect(execSyncMock).toHaveBeenCalledTimes(1)
    expect(execSyncMock.mock.calls[0][1]).toMatchObject({ timeout: 2500 })
  })

  it('uses auth status fallback after fast GitHub CLI API failure', () => {
    originRemoteUrl = 'https://github.com/stablyai/orca.git'
    execSyncMock
      .mockImplementationOnce(() => {
        throw new Error('gh api unavailable')
      })
      .mockImplementationOnce(
        () =>
          'github.com\n  ✓ Logged in to github.com account demo-user\n  - Active account: true\n'
      )

    expect(getGitUsername('/repo')).toBe('demo-user')
    expect(execSyncMock).toHaveBeenCalledTimes(2)
  })
})
