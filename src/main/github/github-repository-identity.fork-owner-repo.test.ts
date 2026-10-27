import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from '../git/runner'

// Fork PR reads prefer upstream while origin-only probes retain the checkout identity.

const { gitExecFileAsyncMock, ghExecFileAsyncMock, readLocalGitConfigSignatureMock } = vi.hoisted(
  () => ({
    gitExecFileAsyncMock: vi.fn(),
    ghExecFileAsyncMock: vi.fn(),
    readLocalGitConfigSignatureMock: vi.fn(async () => 'sig')
  })
)

vi.mock('../git/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof GitRunner>()),
  gitExecFileAsync: gitExecFileAsyncMock,
  ghExecFileAsync: ghExecFileAsyncMock
}))

vi.mock('./local-git-config-signature', () => ({
  readLocalGitConfigSignature: readLocalGitConfigSignatureMock
}))

import { _resetRemoteNameListingCache } from '../git/remote-name-listing'
import { getOwnerRepoForRemote, _resetOwnerRepoCache } from './github-repository-identity'
import { getOwnerRepo } from './github-owner-repo-selection'
import { getRepoUpstream } from './client/fetch/repo-slug-upstream'

const FORK_PATH = '/tmp/fork-checkout'
const NON_FORK_PATH = '/tmp/plain-checkout'
const SSH_FORK_PATH = '/tmp/ssh-fork-checkout'

const REMOTE_URLS_BY_REPO: Record<string, Record<string, string>> = {
  [FORK_PATH]: {
    origin: 'https://github.com/fsdwen/orca.git',
    upstream: 'https://github.com/stablyai/orca.git'
  },
  [NON_FORK_PATH]: {
    origin: 'https://github.com/stablyai/orca.git'
  },
  [SSH_FORK_PATH]: {
    origin: 'git@github.com:fsdwen/orca.git',
    upstream: 'git@github.com:stablyai/orca.git'
  }
}

beforeEach(() => {
  _resetOwnerRepoCache()
  _resetRemoteNameListingCache()
  gitExecFileAsyncMock.mockReset()
  ghExecFileAsyncMock.mockReset()
  gitExecFileAsyncMock.mockImplementation(
    async (args: string[], options: { cwd?: string } = {}) => {
      const configured = REMOTE_URLS_BY_REPO[options.cwd ?? ''] ?? {}
      if (args[0] === 'remote' && args[1] !== 'get-url') {
        return { stdout: `${Object.keys(configured).join('\n')}\n` }
      }
      const remoteName = args[2]
      const url = configured[remoteName]
      if (!url) {
        const err = new Error(`fatal: No such remote '${remoteName}'`) as Error & { code?: number }
        err.code = 128
        throw err
      }
      return { stdout: url }
    }
  )
})

describe('issue #7331: fork PR owner/repo resolution', () => {
  it('getOwnerRepo prefers the upstream parent on a fork checkout', async () => {
    const prRepo = await getOwnerRepo(FORK_PATH)

    expect(prRepo).toEqual({ owner: 'stablyai', repo: 'orca' })
  })

  it('getOwnerRepo falls back to origin when there is no upstream remote', async () => {
    const prRepo = await getOwnerRepo(NON_FORK_PATH)

    expect(prRepo).toEqual({ owner: 'stablyai', repo: 'orca' })
  })

  it('skips git remote get-url upstream on origin-only clones and caches the listing', async () => {
    await getOwnerRepo(NON_FORK_PATH)
    const upstreamGetUrl = (): number =>
      gitExecFileAsyncMock.mock.calls.filter(
        ([args]) => args[1] === 'get-url' && args[2] === 'upstream'
      ).length
    const listCalls = (): number =>
      gitExecFileAsyncMock.mock.calls.filter(
        ([args]) => args[0] === 'remote' && args[1] !== 'get-url'
      ).length
    expect(upstreamGetUrl()).toBe(0)
    expect(listCalls()).toBe(1)

    await getOwnerRepo(NON_FORK_PATH)
    expect(upstreamGetUrl()).toBe(0)
    expect(listCalls()).toBe(1)
  })

  it('resolves the upstream parent for SSH-style remote URLs', async () => {
    const prRepo = await getOwnerRepo(SSH_FORK_PATH)

    expect(prRepo).toEqual({ owner: 'stablyai', repo: 'orca' })
  })

  it('getOwnerRepoForRemote(origin) still resolves the fork itself', async () => {
    const origin = await getOwnerRepoForRemote(FORK_PATH, 'origin')

    expect(origin).toEqual({ owner: 'fsdwen', repo: 'orca' })
  })

  it('getRepoUpstream still resolves the fork parent offline (regression)', async () => {
    // An upstream-first origin probe would hide the fork distinction and defeat the offline fast path.
    const upstream = await getRepoUpstream(FORK_PATH)

    expect(upstream).toEqual({ owner: 'stablyai', repo: 'orca', host: 'github.com' })
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
