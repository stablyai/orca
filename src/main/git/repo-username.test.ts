import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RunnerModule from './runner'

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())
const ghExecFileAsyncMock = vi.hoisted(() => vi.fn())

vi.mock('./runner', async () => {
  const actual = await vi.importActual<typeof RunnerModule>('./runner')
  return {
    ...actual,
    gitExecFileAsync: gitExecFileAsyncMock,
    ghExecFileAsync: ghExecFileAsyncMock
  }
})

import {
  resolveLocalGitUsername,
  resolveLocalGitUsernameDetailed,
  resetGhLoginCacheForTests
} from './git-username'

function makeExecError(
  message: string,
  extra: { code?: string; killed?: boolean; signal?: string; stderr?: string } = {}
): Error {
  return Object.assign(new Error(message), { stdout: '', stderr: '', ...extra })
}

describe('resolveLocalGitUsername', () => {
  let gitConfig: Record<string, string>
  let originRemoteUrl: string | undefined
  let remoteUrls: Record<string, string>
  let currentBranch: string

  beforeEach(() => {
    vi.resetAllMocks()
    resetGhLoginCacheForTests()
    gitConfig = {}
    originRemoteUrl = undefined
    remoteUrls = {}
    currentBranch = ''

    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'config' && args[1] === '--get') {
        const value = gitConfig[args[2]]
        if (value !== undefined) {
          return { stdout: `${value}\n`, stderr: '' }
        }
        throw makeExecError(`missing config ${args[2]}`)
      }
      if (args[0] === 'remote' && args.length === 1) {
        const remotes = new Set(Object.keys(remoteUrls))
        if (originRemoteUrl) {
          remotes.add('origin')
        }
        return { stdout: `${[...remotes].join('\n')}\n`, stderr: '' }
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        const remoteUrl = args[2] === 'origin' ? originRemoteUrl : remoteUrls[args[2]]
        if (remoteUrl) {
          return { stdout: `${remoteUrl}\n`, stderr: '' }
        }
        throw makeExecError(`missing ${args[2]} remote`)
      }
      if (args[0] === 'branch' && args[1] === '--show-current') {
        return { stdout: `${currentBranch}\n`, stderr: '' }
      }
      if (args[0] === 'symbolic-ref') {
        // origin/HEAD unset — resolveDefaultBaseRefViaExec falls through to probes.
        throw makeExecError('no origin/HEAD')
      }
      if (args[0] === 'rev-parse') {
        throw makeExecError(`missing ref ${args.at(-1)}`)
      }
      throw makeExecError(`unexpected git args: ${args.join(' ')}`)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('prefers explicit GitHub user config before checking GitHub CLI login', async () => {
    originRemoteUrl = 'https://github.com/stablyai/orca.git'
    gitConfig['github.user'] = 'config-demo'
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'gh-demo\n', stderr: '' })

    await expect(resolveLocalGitUsername('/repo')).resolves.toBe('config-demo')
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('uses explicit username config before checking GitHub CLI login', async () => {
    originRemoteUrl = 'https://github.com/stablyai/orca.git'
    gitConfig['user.username'] = 'repo-demo'
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'gh-demo\n', stderr: '' })

    await expect(resolveLocalGitUsername('/repo')).resolves.toBe('repo-demo')
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('uses GitHub CLI login for GitHub remotes instead of repo-local author identity', async () => {
    originRemoteUrl = 'https://github.com/stablyai/orca.git'
    gitConfig['user.email'] = 'demo@example.com'
    gitConfig['user.name'] = 'Demo User'
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'gh-demo\n', stderr: '' })

    await expect(resolveLocalGitUsername('/repo')).resolves.toBe('gh-demo')
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('uses GitHub CLI login for a single GitHub remote not named origin', async () => {
    remoteUrls.upstream = 'https://github.com/stablyai/orca.git'
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'gh-demo\n', stderr: '' })

    await expect(resolveLocalGitUsername('/repo')).resolves.toBe('gh-demo')
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('uses GitHub CLI login for GitHub SSH-over-443 remotes', async () => {
    remoteUrls.upstream = 'ssh://git@ssh.github.com:443/stablyai/orca.git'
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'gh-demo\n', stderr: '' })

    await expect(resolveLocalGitUsername('/repo')).resolves.toBe('gh-demo')
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('does not derive GitHub username prefixes from non-GitHub remotes', async () => {
    originRemoteUrl = 'https://gitlab.com/stablyai/orca.git'
    gitConfig['user.email'] = 'demo@example.com'
    gitConfig['user.name'] = 'Demo User'
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'gh-demo\n', stderr: '' })

    await expect(resolveLocalGitUsername('/repo')).resolves.toBe('')
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('ignores a secondary GitHub mirror when the effective remote is GitLab', async () => {
    // Why: a GitLab-primary repo with a GitHub mirror must not pick up the
    // GitHub account name as its branch prefix — only the effective remote
    // (branch remote / default base remote / origin / lone remote) counts.
    originRemoteUrl = 'https://gitlab.com/stablyai/orca.git'
    remoteUrls['github-mirror'] = 'https://github.com/stablyai/orca.git'
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'gh-demo\n', stderr: '' })

    await expect(resolveLocalGitUsername('/repo')).resolves.toBe('')
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('bounds and caches failed GitHub CLI lookup', async () => {
    originRemoteUrl = 'https://github.com/stablyai/orca.git'
    ghExecFileAsyncMock.mockRejectedValue(makeExecError('gh unavailable'))

    await expect(resolveLocalGitUsername('/repo')).resolves.toBe('')
    await expect(resolveLocalGitUsername('/repo')).resolves.toBe('')

    // api + auth-status fallback on the first resolution; cached afterwards.
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    for (const [, options] of ghExecFileAsyncMock.mock.calls) {
      expect(options).toMatchObject({ timeout: 2500 })
    }
  })

  it('skips auth status fallback when GitHub CLI API lookup times out', async () => {
    originRemoteUrl = 'https://github.com/stablyai/orca.git'
    ghExecFileAsyncMock.mockRejectedValueOnce(
      makeExecError('spawnSync gh ETIMEDOUT', { code: 'ETIMEDOUT' })
    )

    await expect(resolveLocalGitUsername('/repo')).resolves.toBe('')
    await expect(resolveLocalGitUsername('/repo')).resolves.toBe('')

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('treats a Windows timeout kill (SIGTERM, no ETIMEDOUT code) as a timeout', async () => {
    // Why: on Windows the exec timeout kill surfaces killed/SIGTERM without an
    // ETIMEDOUT code; the old sync probe missed this and ran a second equally
    // stuck probe (issue #7225).
    originRemoteUrl = 'https://github.com/stablyai/orca.git'
    ghExecFileAsyncMock.mockRejectedValueOnce(
      makeExecError('gh was killed', { killed: true, signal: 'SIGTERM' })
    )

    await expect(resolveLocalGitUsername('/repo')).resolves.toBe('')
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('marks a timed-out gh probe non-authoritative and retries after the cooldown', async () => {
    vi.useFakeTimers()
    originRemoteUrl = 'https://github.com/stablyai/orca.git'
    ghExecFileAsyncMock
      .mockRejectedValueOnce(makeExecError('gh timeout', { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce({ stdout: 'gh-demo\n', stderr: '' })

    await expect(resolveLocalGitUsernameDetailed('/repo')).resolves.toEqual({
      username: '',
      authoritative: false
    })
    // Within the cooldown the timeout result is reused without a new spawn.
    await expect(resolveLocalGitUsernameDetailed('/repo')).resolves.toEqual({
      username: '',
      authoritative: false
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    await expect(resolveLocalGitUsernameDetailed('/repo')).resolves.toEqual({
      username: 'gh-demo',
      authoritative: true
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('reports authoritative empty for non-GitHub repos', async () => {
    originRemoteUrl = 'https://gitlab.com/stablyai/orca.git'

    await expect(resolveLocalGitUsernameDetailed('/repo')).resolves.toEqual({
      username: '',
      authoritative: true
    })
  })

  it('uses auth status fallback after fast GitHub CLI API failure', async () => {
    originRemoteUrl = 'https://github.com/stablyai/orca.git'
    ghExecFileAsyncMock
      .mockRejectedValueOnce(makeExecError('gh api unavailable'))
      .mockResolvedValueOnce({
        stdout: '',
        stderr:
          'github.com\n  ✓ Logged in to github.com account demo-user\n  - Active account: true\n'
      })

    await expect(resolveLocalGitUsername('/repo')).resolves.toBe('demo-user')
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('settles within the wall even when the gh child never exits', async () => {
    vi.useFakeTimers()
    originRemoteUrl = 'https://github.com/stablyai/orca.git'
    // A promise that never settles — models a killed gh whose grandchild
    // keeps the stdio pipes open past the exec timeout.
    ghExecFileAsyncMock.mockImplementation(() => new Promise(() => {}))

    const resolution = resolveLocalGitUsernameDetailed('/repo')
    await vi.advanceTimersByTimeAsync(10_100)
    await expect(resolution).resolves.toEqual({ username: '', authoritative: false })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('picks the active account from a multi-account auth status output', async () => {
    // Why: each account block prints its login line BEFORE its
    // "Active account" marker; a cross-block regex would capture the next
    // block's login instead of the active one.
    originRemoteUrl = 'https://github.com/stablyai/orca.git'
    ghExecFileAsyncMock
      .mockRejectedValueOnce(makeExecError('gh api unavailable'))
      .mockResolvedValueOnce({
        stdout: '',
        stderr: [
          'github.com',
          '  ✓ Logged in to github.com account active-user (keyring)',
          '  - Active account: true',
          '  - Git operations protocol: https',
          '  ✓ Logged in to github.com account inactive-user (keyring)',
          '  - Active account: false'
        ].join('\n')
      })

    await expect(resolveLocalGitUsername('/repo')).resolves.toBe('active-user')
  })
})
