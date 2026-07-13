import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/types'
import type * as RunnerModule from './git/runner'

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())
const ghExecFileAsyncMock = vi.hoisted(() => vi.fn())

vi.mock('./git/runner', async () => {
  const actual = await vi.importActual<typeof RunnerModule>('./git/runner')
  return {
    ...actual,
    gitExecFileAsync: gitExecFileAsyncMock,
    ghExecFileAsync: ghExecFileAsyncMock
  }
})

import {
  LOCAL_GIT_USERNAME_TIMEOUT_RETRY_MS,
  resetGhLoginCacheForTests
} from './git/git-username'
import {
  enrichRepoGitUsernames,
  flushRepoGitUsernameEnrichmentForTests,
  resetRepoGitUsernameEnrichmentForTests
} from './repo-git-username-enrichment'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'shared',
    path: 'C:/repos/one',
    displayName: 'One',
    badgeColor: '#000',
    addedAt: 1,
    ...overrides
  } as Repo
}

function makeExecError(message: string, code?: string): Error {
  return Object.assign(new Error(message), { stdout: '', stderr: '', code })
}

describe('repo git username enrichment subprocess budget', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    resetGhLoginCacheForTests()
    resetRepoGitUsernameEnrichmentForTests()
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args.length === 1) {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'branch' && args[1] === '--show-current') {
        return { stdout: '\n', stderr: '' }
      }
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
        return { stdout: 'https://github.com/stablyai/orca.git\n', stderr: '' }
      }
      throw makeExecError(`missing git value: ${args.join(' ')}`)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('suppresses every git and gh subprocess until the lifecycle cooldown expires', async () => {
    vi.useFakeTimers()
    ghExecFileAsyncMock
      .mockRejectedValueOnce(makeExecError('gh timed out', 'ETIMEDOUT'))
      .mockResolvedValueOnce({ stdout: 'recovered-user\n', stderr: '' })
    const localRepo = makeRepo()
    const repos = [
      makeRepo({ connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' }),
      makeRepo({ executionHostId: 'runtime:environment-1' }),
      localRepo
    ]
    const store = {
      getRepos: () => repos,
      setResolvedRepoGitUsername: vi.fn(() => true)
    }

    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()

    // Two config reads + remote/default-base/current-branch/effective-remote probes.
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(10)
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)

    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()

    // Repeated repos:list calls and non-local provider twins do zero extra work.
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(10)
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(LOCAL_GIT_USERNAME_TIMEOUT_RETRY_MS + 1)
    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(20)
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(store.setResolvedRepoGitUsername).toHaveBeenCalledWith(
      'shared',
      'recovered-user',
      expect.objectContaining({ path: localRepo.path, addedAt: localRepo.addedAt })
    )
    for (const [, options] of gitExecFileAsyncMock.mock.calls) {
      expect(options).toMatchObject({ cwd: localRepo.path, timeout: 5000 })
    }
  })
})
