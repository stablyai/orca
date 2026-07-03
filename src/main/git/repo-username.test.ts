import { beforeEach, describe, expect, it, vi } from 'vitest'
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

import { resolveLocalGitUsername, resetGhLoginCacheForTests } from './git-username'

function makeExecError(
  message: string,
  extra: { code?: string; killed?: boolean; signal?: string; stderr?: string } = {}
): Error {
  return Object.assign(new Error(message), { stdout: '', stderr: '', ...extra })
}

describe('resolveLocalGitUsername', () => {
  let gitConfig: Record<string, string>
  let remoteLines: string[]

  beforeEach(() => {
    vi.resetAllMocks()
    resetGhLoginCacheForTests()
    gitConfig = {}
    remoteLines = []

    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'config' && args[1] === '--get') {
        const value = gitConfig[args[2]]
        if (value !== undefined) {
          return { stdout: `${value}\n`, stderr: '' }
        }
        throw makeExecError(`missing config ${args[2]}`)
      }
      if (args[0] === 'remote' && args[1] === '-v') {
        return { stdout: `${remoteLines.join('\n')}\n`, stderr: '' }
      }
      throw makeExecError(`unexpected git args: ${args.join(' ')}`)
    })
  })

  it('prefers explicit GitHub user config before checking GitHub CLI login', async () => {
    remoteLines = ['origin\thttps://github.com/stablyai/orca.git (fetch)']
    gitConfig['github.user'] = 'config-demo'
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'gh-demo\n', stderr: '' })

    await expect(resolveLocalGitUsername('/repo')).resolves.toBe('config-demo')
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('uses explicit username config before checking GitHub CLI login', async () => {
    remoteLines = ['origin\thttps://github.com/stablyai/orca.git (fetch)']
    gitConfig['user.username'] = 'repo-demo'
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'gh-demo\n', stderr: '' })

    await expect(resolveLocalGitUsername('/repo')).resolves.toBe('repo-demo')
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('uses GitHub CLI login for GitHub remotes instead of repo-local author identity', async () => {
    remoteLines = ['origin\thttps://github.com/stablyai/orca.git (fetch)']
    gitConfig['user.email'] = 'demo@example.com'
    gitConfig['user.name'] = 'Demo User'
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'gh-demo\n', stderr: '' })

    await expect(resolveLocalGitUsername('/repo')).resolves.toBe('gh-demo')
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('uses GitHub CLI login for a single GitHub remote not named origin', async () => {
    remoteLines = ['upstream\thttps://github.com/stablyai/orca.git (fetch)']
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'gh-demo\n', stderr: '' })

    await expect(resolveLocalGitUsername('/repo')).resolves.toBe('gh-demo')
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('uses GitHub CLI login for GitHub SSH-over-443 remotes', async () => {
    remoteLines = ['upstream\tssh://git@ssh.github.com:443/stablyai/orca.git (fetch)']
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'gh-demo\n', stderr: '' })

    await expect(resolveLocalGitUsername('/repo')).resolves.toBe('gh-demo')
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('does not derive GitHub username prefixes from non-GitHub remotes', async () => {
    remoteLines = ['origin\thttps://gitlab.com/stablyai/orca.git (fetch)']
    gitConfig['user.email'] = 'demo@example.com'
    gitConfig['user.name'] = 'Demo User'
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'gh-demo\n', stderr: '' })

    await expect(resolveLocalGitUsername('/repo')).resolves.toBe('')
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('bounds and caches failed GitHub CLI lookup', async () => {
    remoteLines = ['origin\thttps://github.com/stablyai/orca.git (fetch)']
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
    remoteLines = ['origin\thttps://github.com/stablyai/orca.git (fetch)']
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
    remoteLines = ['origin\thttps://github.com/stablyai/orca.git (fetch)']
    ghExecFileAsyncMock.mockRejectedValueOnce(
      makeExecError('gh was killed', { killed: true, signal: 'SIGTERM' })
    )

    await expect(resolveLocalGitUsername('/repo')).resolves.toBe('')
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('uses auth status fallback after fast GitHub CLI API failure', async () => {
    remoteLines = ['origin\thttps://github.com/stablyai/orca.git (fetch)']
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
    try {
      remoteLines = ['origin\thttps://github.com/stablyai/orca.git (fetch)']
      // A promise that never settles — models a killed gh whose grandchild
      // keeps the stdio pipes open past the exec timeout.
      ghExecFileAsyncMock.mockImplementation(() => new Promise(() => {}))

      const resolution = resolveLocalGitUsername('/repo')
      await vi.advanceTimersByTimeAsync(3100)
      await expect(resolution).resolves.toBe('')
      expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
