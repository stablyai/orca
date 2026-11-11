import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, glabExecFileAsyncMock, readLocalGitConfigSignatureMock } = vi.hoisted(
  () => ({
    gitExecFileAsyncMock: vi.fn(),
    glabExecFileAsyncMock: vi.fn(),
    readLocalGitConfigSignatureMock: vi.fn()
  })
)

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../git/command-runner/glab-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  glabExecFileAsync: glabExecFileAsyncMock
}))

vi.mock('../github/local-git-config-signature', () => ({
  readLocalGitConfigSignature: readLocalGitConfigSignatureMock
}))
import {
  _getProjectRefCacheSize,
  _resetProjectRefCache,
  acquire,
  release,
  GITLAB_ADMISSION_TIMEOUT_MS,
  getIssueProjectRef,
  getProjectRef,
  getProjectRefForRemote
} from './gl-utils'
import { _resetRemoteNameListingCache } from '../git/remotes/remote-name-listing'

function mockGitRemoteCommands(remotes: Record<string, string>): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'remote' && args[1] !== 'get-url') {
      return { stdout: `${Object.keys(remotes).join('\n')}\n` }
    }
    if (args[0] === 'remote' && args[1] === 'get-url') {
      const url = remotes[args[2] ?? '']
      if (!url) {
        throw new Error(`fatal: No such remote '${args[2]}'`)
      }
      return { stdout: url }
    }
    throw new Error(`unexpected git ${args.join(' ')}`)
  })
}

function gitRemoteGetUrlCalls(remoteName: string): unknown[][] {
  return gitExecFileAsyncMock.mock.calls.filter(
    ([args]) =>
      Array.isArray(args) && args[0] === 'remote' && args[1] === 'get-url' && args[2] === remoteName
  )
}

describe('gitlab project ref resolution', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    glabExecFileAsyncMock.mockReset()
    _resetProjectRefCache()
    _resetRemoteNameListingCache()
    readLocalGitConfigSignatureMock
      .mockReset()
      .mockImplementation(async (context: { wslDistro?: string }) =>
        context.wslDistro ? undefined : 'sig-1'
      )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(['sig-2', undefined])(
    'does not return a warm identity after freshness was lost (%s) and the probe timed out',
    async (signature) => {
      mockGitRemoteCommands({ origin: 'git@gitlab.com:team/project.git\n' })
      await expect(getProjectRef('/repo')).resolves.toEqual({
        host: 'gitlab.com',
        path: 'team/project'
      })
      gitExecFileAsyncMock.mockRejectedValue(new Error('git remote get-url timed out'))
      readLocalGitConfigSignatureMock.mockResolvedValue(signature)

      await expect(getProjectRef('/repo')).resolves.toBeNull()
    }
  )

  it.each(['before capture', 'after capture', 'late publication'])(
    'refreshes on the next independent signature after an edit (%s)',
    async (ordering) => {
      const captured = Promise.withResolvers<void>()
      const release = Promise.withResolvers<{ stdout: string }>()
      const oldUrl = 'git@gitlab.com:team/old.git'
      const newUrl = 'git@gitlab.com:team/current.git'
      readLocalGitConfigSignatureMock.mockResolvedValue('sig-0')
      gitExecFileAsyncMock
        .mockImplementationOnce(() => {
          captured.resolve()
          return release.promise
        })
        .mockResolvedValue({ stdout: newUrl })
      const old = getProjectRefForRemote('/repo', 'origin')
      await captured.promise
      readLocalGitConfigSignatureMock.mockResolvedValue('sig-1')
      if (ordering === 'late publication') {
        expect((await getProjectRefForRemote('/repo', 'origin'))?.path).toBe('team/current')
      }
      release.resolve({ stdout: ordering === 'before capture' ? newUrl : oldUrl })
      expect((await old)?.path).toBe(ordering === 'before capture' ? 'team/current' : 'team/old')
      expect((await getProjectRefForRemote('/repo', 'origin'))?.path).toBe('team/current')
      const reads = gitExecFileAsyncMock.mock.calls.length
      expect(reads).toBe(ordering === 'late publication' ? 3 : 2)
      expect((await getProjectRefForRemote('/repo', 'origin'))?.path).toBe('team/current')
      expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(reads)
    }
  )

  it('falls back on an upstream timeout and retries upstream on the next attempt', async () => {
    mockGitRemoteCommands({
      origin: 'git@gitlab.com:fork/orca.git\n',
      upstream: 'git@example.com:stablyai/orca.git\n'
    })

    const serve = gitExecFileAsyncMock.getMockImplementation()
    gitExecFileAsyncMock.mockImplementation((args: string[]) =>
      args[2] === 'upstream' ? Promise.reject(new Error('git timed out')) : serve?.(args)
    )
    await expect(getIssueProjectRef('/repo')).resolves.toEqual({
      host: 'gitlab.com',
      path: 'fork/orca'
    })
    expect(gitRemoteGetUrlCalls('upstream')).toHaveLength(1)
    expect(gitRemoteGetUrlCalls('origin')).toHaveLength(1)
    mockGitRemoteCommands({ upstream: 'git@gitlab.com:team/recovered.git' })
    expect((await getIssueProjectRef('/repo'))?.path).toBe('team/recovered')
    expect(gitRemoteGetUrlCalls('upstream')).toHaveLength(2)
  })

  // `glab auth status --hostname <host>` output (glab 1.102) for a host with a stray config entry.
  function rejectHostnameProbeWithStatusBlock(host: string): void {
    glabExecFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('glab auth status failed'), {
        stdout: '',
        stderr: [
          host,
          `  x ${host}: API call failed: 404 Not Found`,
          '  ✓ Token found: **************************'
        ].join('\n')
      })
    )
  }

  it.each([
    ['https://github.com/owner/repo.git', 'github.com'],
    ['git@bitbucket.org:owner/repo.git', 'bitbucket.org']
  ])('does not claim %s from a stray glab %s host entry', async (url, host) => {
    mockGitRemoteCommands({ origin: url })
    rejectHostnameProbeWithStatusBlock(host)

    await expect(getProjectRef('/repo')).resolves.toBeNull()
  })

  it('does not claim a github.com remote listed in the glab known-host inventory', async () => {
    mockGitRemoteCommands({ origin: 'git@github.com:owner/repo.git' })

    await expect(getProjectRef('/repo', ['gitlab.com', 'github.com'])).resolves.toBeNull()
  })
})

describe('GitLab operation admission', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (let i = 0; i < 4; i += 1) {
      release()
    }
  })

  it('expires queued work instead of retaining it behind saturated operations', async () => {
    vi.useFakeTimers()
    await Promise.all(Array.from({ length: 4 }, () => acquire()))

    const queued = acquire()
    const rejection = expect(queued).rejects.toThrow(
      'Timed out waiting for a GitLab operation slot.'
    )
    await vi.advanceTimersByTimeAsync(GITLAB_ADMISSION_TIMEOUT_MS)
    await rejection

    release()
    await expect(acquire()).resolves.toBeUndefined()
  })
})
