import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from '../git/runner'

// A resolved repo identity used to expire on a flat 30s clock, so a client
// polling PR state re-ran `git remote get-url` for every repo every half
// minute. On Windows that spawn costs 250-800ms in the field. The identity is
// a read of `.git/config`, and the config signature already exists to say when
// that file changed — so a signed answer is now held for the same five minutes
// a signed negative already was, and revalidated against the signature.

const { gitExecFileAsyncMock, readLocalGitConfigSignatureMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  readLocalGitConfigSignatureMock: vi.fn<() => Promise<string | undefined>>(async () => 'sig-1')
}))

vi.mock('../git/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof GitRunner>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: () => null,
  getSshGitProviderGeneration: () => 0,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'ssh git provider unavailable'
}))

vi.mock('./local-git-config-signature', () => ({
  readLocalGitConfigSignature: readLocalGitConfigSignatureMock
}))

import { getOwnerRepoForRemote, _resetOwnerRepoCache } from './github-repository-identity'

const REPO = '/tmp/signed-cache-repo'
const THIRTY_SECONDS = 30_000
const FOUR_MINUTES = 4 * 60_000

let remoteUrl = 'https://github.com/stablyai/orca.git'

const remoteGetUrlCalls = (): number =>
  gitExecFileAsyncMock.mock.calls.filter(([args]) => (args as string[])[1] === 'get-url').length

beforeEach(() => {
  _resetOwnerRepoCache()
  vi.useRealTimers()
  gitExecFileAsyncMock.mockReset()
  remoteUrl = 'https://github.com/stablyai/orca.git'
  readLocalGitConfigSignatureMock.mockReset()
  readLocalGitConfigSignatureMock.mockImplementation(async () => 'sig-1')
  gitExecFileAsyncMock.mockImplementation(async () => ({ stdout: remoteUrl }))
})

describe('owner/repo identity cache', () => {
  it('holds a signed identity past the unsigned TTL instead of re-spawning git', async () => {
    vi.useFakeTimers()
    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toEqual({
      owner: 'stablyai',
      repo: 'orca'
    })
    expect(remoteGetUrlCalls()).toBe(1)

    // Why 4 minutes: past the 30s unsigned TTL that forced the re-probe, and
    // still inside the signed window this change introduces.
    vi.setSystemTime(Date.now() + FOUR_MINUTES)
    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toEqual({
      owner: 'stablyai',
      repo: 'orca'
    })
    expect(remoteGetUrlCalls()).toBe(1)
    vi.useRealTimers()
  })

  it('re-probes as soon as the git config signature changes', async () => {
    vi.useFakeTimers()
    await getOwnerRepoForRemote(REPO, 'origin')
    expect(remoteGetUrlCalls()).toBe(1)

    remoteUrl = 'https://github.com/other-org/orca.git'
    readLocalGitConfigSignatureMock.mockImplementation(async () => 'sig-2')
    vi.setSystemTime(Date.now() + THIRTY_SECONDS)

    // Why not "after the TTL": a `git remote set-url` must be visible on the
    // very next lookup, which is what the longer hold is allowed to rely on.
    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toEqual({
      owner: 'other-org',
      repo: 'orca'
    })
    expect(remoteGetUrlCalls()).toBe(2)
    vi.useRealTimers()
  })

  it('keeps the short TTL when no signature can be read', async () => {
    vi.useFakeTimers()
    readLocalGitConfigSignatureMock.mockImplementation(async () => undefined)
    await getOwnerRepoForRemote(REPO, 'origin')
    expect(remoteGetUrlCalls()).toBe(1)

    // Why: with no signature nothing invalidates on change, so the entry must
    // still expire on the clock rather than silently pinning a stale identity.
    vi.setSystemTime(Date.now() + THIRTY_SECONDS + 1)
    await getOwnerRepoForRemote(REPO, 'origin')
    expect(remoteGetUrlCalls()).toBe(2)
    vi.useRealTimers()
  })

  it('still coalesces concurrent lookups onto one probe', async () => {
    const [first, second] = await Promise.all([
      getOwnerRepoForRemote(REPO, 'origin'),
      getOwnerRepoForRemote(REPO, 'origin')
    ])
    expect(first).toEqual({ owner: 'stablyai', repo: 'orca' })
    expect(second).toEqual(first)
    expect(remoteGetUrlCalls()).toBe(1)
  })
})
