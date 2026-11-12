import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitExecFileModule from '../git/command-runner/git-exec-file'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>()
}))

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GitExecFileModule>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { _resetOwnerRepoCache } from './gh-utils'
import { _resetRemoteNameListingCache } from '../git/remotes/remote-name-listing'
import {
  _resetOriginGitHubApiRepositoryCache,
  getGitHubApiRepositoryForRemote
} from './github-api-repository-remote-probe'

// Why: no real .git config means no config signature, so caches use their short unsigned TTLs.
const REPO_PATH = '/does-not-exist/orca-remote-probe-fixture'

function mockRemotes(remotes: Record<string, string>): void {
  gitExecFileAsyncMock.mockImplementation((args) => {
    if (args[0] === 'remote' && args.length === 1) {
      return Promise.resolve({ stdout: Object.keys(remotes).join('\n'), stderr: '' })
    }
    if (args[0] === 'remote' && args[1] === 'get-url') {
      const url = remotes[args[2]]
      if (url) {
        return Promise.resolve({ stdout: `${url}\n`, stderr: '' })
      }
      return Promise.reject(
        Object.assign(new Error(`git remote get-url ${args[2]}`), {
          stderr: `error: No such remote '${args[2]}'`
        })
      )
    }
    return Promise.reject(new Error(`unexpected git exec: ${JSON.stringify(args)}`))
  })
}

function getUrlCalls(remoteName: string): number {
  return gitExecFileAsyncMock.mock.calls.filter(
    ([args]) => args[0] === 'remote' && args[1] === 'get-url' && args[2] === remoteName
  ).length
}

beforeEach(() => {
  vi.useFakeTimers()
  gitExecFileAsyncMock.mockReset()
  _resetOriginGitHubApiRepositoryCache()
  _resetOwnerRepoCache()
  _resetRemoteNameListingCache()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('getGitHubApiRepositoryForRemote', () => {
  it('does not run get-url for a non-origin remote the listing says is absent', async () => {
    mockRemotes({ origin: 'https://github.com/acme/widgets.git' })

    for (let poll = 0; poll < 3; poll += 1) {
      await expect(getGitHubApiRepositoryForRemote(REPO_PATH, 'upstream')).resolves.toBeNull()
      await vi.advanceTimersByTimeAsync(60_000)
    }

    expect(getUrlCalls('upstream')).toBe(0)
  })

  it('still resolves a configured upstream remote', async () => {
    mockRemotes({
      origin: 'https://github.com/acme/orca.git',
      upstream: 'https://github.com/stablyai/orca.git'
    })

    await expect(getGitHubApiRepositoryForRemote(REPO_PATH, 'upstream')).resolves.toEqual({
      owner: 'stablyai',
      repo: 'orca',
      host: 'github.com'
    })
  })

  it('probes origin even when the listing omits it', async () => {
    mockRemotes({})

    await expect(getGitHubApiRepositoryForRemote(REPO_PATH, 'origin')).resolves.toBeNull()
    expect(getUrlCalls('origin')).toBeGreaterThan(0)
  })
})
