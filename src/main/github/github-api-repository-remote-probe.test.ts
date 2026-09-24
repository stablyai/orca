import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Runner from '../git/runner'

/**
 * Regression coverage for the `git remote get-url upstream` probe loop: a repo
 * with no `upstream` remote (the common case — most clones only have `origin`)
 * was spawning up to two failing `git remote get-url upstream` execs on every
 * poll of any caller that resolves a named remote through
 * {@link getGitHubApiRepositoryForRemote} without first checking
 * `shouldProbeGitRemote` — e.g. `getRepoUpstream` (repo-slug-upstream.ts) and
 * the tracked-upstream-branch fallback in branch-lookup-resolution.ts, which
 * the 60s hosted-review sidebar poller (ACTIVE_REFRESH_INTERVAL_MS) reaches
 * through `getPRForBranchOutcome` -> `resolvePRForBranchOutcome`.
 *
 * The double exec per cold call came from two independent uncached
 * `git remote get-url <name>` reads inside one `getGitHubApiRepositoryForRemote`
 * call: one in `getOwnerRepoForRemote` (github-repository-identity.ts), and a
 * second, wholly separate one in `getEnterpriseGitHubRepoSlugForRemote`
 * (github-enterprise-repository.ts) once the first came back empty.
 */

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>()
}))

vi.mock('../git/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof Runner>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { _resetOwnerRepoCache } from './gh-utils'
import { _resetRemoteNameListingCache } from '../git/remote-name-listing'
import {
  _resetOriginGitHubApiRepositoryCache,
  getGitHubApiRepositoryForRemote
} from './github-api-repository-remote-probe'

// Why: a path that cannot resolve to a real .git directory keeps
// readLocalGitConfigSignature's filesystem probe deterministic (always
// undefined), so every cache in this chain lands on its unsigned TTL tier
// instead of depending on this machine's actual filesystem state.
const REPO_PATH = 'Z:\\does-not-exist\\orca-upstream-probe-loop-fixture'

function execCalls(): string[][] {
  return gitExecFileAsyncMock.mock.calls.map(([args]) => args)
}

function remoteGetUrlCallsFor(remoteName: string): string[][] {
  return execCalls().filter(
    (args) => args[0] === 'remote' && args[1] === 'get-url' && args[2] === remoteName
  )
}

function bareRemoteListCalls(): string[][] {
  return execCalls().filter((args) => args.length === 1 && args[0] === 'remote')
}

function missingRemoteError(remoteName: string): Error & { stderr: string } {
  const error = new Error(`Command failed: git remote get-url ${remoteName}`) as Error & {
    stderr: string
  }
  error.stderr = `error: No such remote '${remoteName}'`
  return error
}

/** Only `origin` is configured; every other remote is genuinely missing. */
function originOnlyGitExecImpl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  if (args[0] === 'remote' && args.length === 1) {
    return Promise.resolve({ stdout: 'origin\n', stderr: '' })
  }
  if (args[0] === 'remote' && args[1] === 'get-url') {
    const remoteName = args[2]
    if (remoteName === 'origin') {
      return Promise.resolve({ stdout: 'https://github.com/acme/widgets.git\n', stderr: '' })
    }
    return Promise.reject(missingRemoteError(remoteName))
  }
  return Promise.reject(new Error(`unexpected git exec in test: ${JSON.stringify(args)}`))
}

beforeEach(() => {
  vi.useFakeTimers()
  gitExecFileAsyncMock.mockReset()
  gitExecFileAsyncMock.mockImplementation(originOnlyGitExecImpl)
  _resetOriginGitHubApiRepositoryCache()
  _resetOwnerRepoCache()
  _resetRemoteNameListingCache()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('getGitHubApiRepositoryForRemote upstream probe loop (regression)', () => {
  it('never execs `git remote get-url upstream` for a repo without that remote, across repeated 60s-apart polls', async () => {
    for (let poll = 0; poll < 5; poll += 1) {
      await expect(getGitHubApiRepositoryForRemote(REPO_PATH, 'upstream')).resolves.toBeNull()
      // Why 60s: matches the hosted-review sidebar's ACTIVE_REFRESH_INTERVAL_MS
      // cadence that produced the failing trace (~50s median gap in the wild).
      await vi.advanceTimersByTimeAsync(60_000)
    }

    expect(remoteGetUrlCallsFor('upstream')).toHaveLength(0)
    // Sanity: the gate is doing real work off a real listing, not skipping for
    // lack of trying — the bare `git remote` listing still runs.
    expect(bareRemoteListCalls().length).toBeGreaterThan(0)
  })

  it('never fires the failing probe twice in a row on a single cold call either', async () => {
    await expect(getGitHubApiRepositoryForRemote(REPO_PATH, 'upstream')).resolves.toBeNull()
    expect(remoteGetUrlCallsFor('upstream')).toHaveLength(0)
  })

  it('still resolves upstream when that remote is actually configured (fork/upstream detection intact)', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'remote' && args.length === 1) {
        return Promise.resolve({ stdout: 'origin\nupstream\n', stderr: '' })
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        const remoteName = args[2]
        const url =
          remoteName === 'upstream'
            ? 'https://github.com/stablyai/orca.git'
            : 'https://github.com/acme/orca.git'
        return Promise.resolve({ stdout: `${url}\n`, stderr: '' })
      }
      return Promise.reject(new Error(`unexpected git exec in test: ${JSON.stringify(args)}`))
    })

    await expect(getGitHubApiRepositoryForRemote(REPO_PATH, 'upstream')).resolves.toEqual({
      owner: 'stablyai',
      repo: 'orca',
      host: 'github.com'
    })
    expect(remoteGetUrlCallsFor('upstream')).toHaveLength(1)
  })

  it('re-probes upstream once it is added after being absent (config-signature revalidation)', async () => {
    await expect(getGitHubApiRepositoryForRemote(REPO_PATH, 'upstream')).resolves.toBeNull()
    expect(remoteGetUrlCallsFor('upstream')).toHaveLength(0)

    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'remote' && args.length === 1) {
        return Promise.resolve({ stdout: 'origin\nupstream\n', stderr: '' })
      }
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'upstream') {
        return Promise.resolve({ stdout: 'https://github.com/stablyai/orca.git\n', stderr: '' })
      }
      return Promise.reject(new Error(`unexpected git exec in test: ${JSON.stringify(args)}`))
    })

    // Past the unsigned remote-name-listing TTL (30s), so the next call re-lists.
    await vi.advanceTimersByTimeAsync(60_000)

    await expect(getGitHubApiRepositoryForRemote(REPO_PATH, 'upstream')).resolves.toEqual({
      owner: 'stablyai',
      repo: 'orca',
      host: 'github.com'
    })
  })

  it('still attempts `origin` unconditionally even when the cached listing omits it', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'remote' && args.length === 1) {
        return Promise.resolve({ stdout: '', stderr: '' })
      }
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
        return Promise.reject(missingRemoteError('origin'))
      }
      return Promise.reject(new Error(`unexpected git exec in test: ${JSON.stringify(args)}`))
    })

    await expect(getGitHubApiRepositoryForRemote(REPO_PATH, 'origin')).resolves.toBeNull()
    expect(remoteGetUrlCallsFor('origin').length).toBeGreaterThan(0)
  })
})
