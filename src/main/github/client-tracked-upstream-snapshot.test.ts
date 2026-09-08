import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  git: vi.fn(),
  signature: vi.fn(),
  provider: vi.fn(),
  generation: vi.fn()
}))
vi.mock('../git/runner', () => ({ gitExecFileAsync: mocks.git }))
vi.mock('./local-git-config-signature', () => ({ readLocalGitConfigSignature: mocks.signature }))
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: mocks.provider,
  getSshGitProviderGeneration: mocks.generation,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'Remote connection dropped.'
}))
import {
  getGitRemoteTopologySnapshot,
  _resetGitRemoteTopologySnapshotCache
} from '../git/git-remote-topology-snapshot'

const load = (repoPath = '/repo', connectionId?: string, wslDistro?: string) =>
  getGitRemoteTopologySnapshot({ repoPath, connectionId, localGitOptions: { wslDistro } })
const probe = async (args: string[]) => ({
  stdout:
    args[0] === 'remote'
      ? 'fork\thttps://github.com/contributor/repo (fetch)\nfork\thttps://github.com/contributor/repo (push)'
      : args[0] === 'config'
        ? ''
        : 'refs/heads/feature\0oid\0refs/remotes/fork/published\nrefs/remotes/fork/published\0oid\0'
})

describe('unified topology and tracked-upstream snapshot lifecycle', () => {
  beforeEach(() => {
    _resetGitRemoteTopologySnapshotCache()
    mocks.git.mockReset().mockImplementation(probe)
    mocks.signature.mockReset().mockResolvedValue('sig')
    mocks.provider.mockReset()
    mocks.generation.mockReset().mockReturnValue(0)
  })
  afterEach(() => vi.useRealTimers())

  it('captures full tracked refs and remote tips in one bounded scan', async () => {
    const result = await load()
    expect(result.upstreamRefs.get('feature')).toBe('refs/remotes/fork/published')
    expect(result.remoteBranchOids.get('fork/published')).toBe('oid')
    expect(mocks.git.mock.calls.filter(([args]) => args[0] === 'for-each-ref')).toHaveLength(1)
  })
  it('coalesces concurrent consumers and caches absent tracked refs', async () => {
    await Promise.all([load(), load(), load()])
    await load()
    expect(mocks.git).toHaveBeenCalledTimes(3)
  })
  it('refreshes config changes immediately', async () => {
    await load()
    mocks.signature.mockResolvedValue('new')
    await load()
    expect(mocks.git).toHaveBeenCalledTimes(6)
  })
  it('does not publish a snapshot whose config changed during its probe', async () => {
    mocks.signature.mockResolvedValueOnce('old').mockResolvedValue('new')
    await load()
    await load()
    expect(mocks.git).toHaveBeenCalledTimes(6)
  })
  it('releases coalesced failure state and retries after transient Git failure', async () => {
    mocks.git.mockRejectedValueOnce(new Error('timeout'))
    const outcomes = await Promise.allSettled([load(), load(), load()])
    expect(outcomes.every((result) => result.status === 'rejected')).toBe(true)
    await load()
    expect(mocks.git).toHaveBeenCalledTimes(6)
  })
  it('releases probe state when signature setup rejects', async () => {
    mocks.signature.mockRejectedValueOnce(new Error('signature unavailable'))
    await expect(load()).rejects.toThrow('signature unavailable')
    await expect(load()).resolves.toHaveProperty('upstreamRefs')
  })
  it('isolates native and WSL snapshots', async () => {
    await load()
    await load('/repo', undefined, 'Ubuntu')
    expect(mocks.git).toHaveBeenCalledTimes(6)
    expect(mocks.git).toHaveBeenCalledWith(['remote', '-v'], { cwd: '/repo', wslDistro: 'Ubuntu' })
  })
  it('uses SSH execution and expires unsigned positives', async () => {
    vi.useFakeTimers()
    mocks.signature.mockResolvedValue(undefined)
    const exec = vi.fn(probe)
    mocks.provider.mockReturnValue({ exec })
    await load('/repo', 'ssh')
    await load('/repo', 'ssh')
    expect(exec).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(30_001)
    await load('/repo', 'ssh')
    expect(exec).toHaveBeenCalledTimes(6)
    expect(mocks.git).not.toHaveBeenCalled()
  })
  it('reconnect generation refuses the previous host snapshot', async () => {
    mocks.signature.mockResolvedValue(undefined)
    const exec = vi.fn(probe)
    mocks.provider.mockReturnValue({ exec })
    await load('/repo', 'ssh')
    mocks.generation.mockReturnValue(1)
    await load('/repo', 'ssh')
    expect(exec).toHaveBeenCalledTimes(6)
  })
  it('never substitutes the client when SSH is unavailable', async () => {
    await expect(load('/repo', 'ssh')).rejects.toThrow('Remote connection dropped.')
    expect(mocks.git).not.toHaveBeenCalled()
  })
  it('bounds cached workspaces and sweeps expired entries', async () => {
    vi.useFakeTimers()
    for (let i = 0; i < 513; i++) {
      await load(`/repo-${i}`)
    }
    const count = mocks.git.mock.calls.length
    await load('/repo-0')
    expect(mocks.git).toHaveBeenCalledTimes(count + 3)
    vi.advanceTimersByTime(30_001)
    await load('/repo-512')
    expect(mocks.git).toHaveBeenCalledTimes(count + 6)
  })
  it('fences an abandoned probe from publishing over its replacement', async () => {
    let release!: (value: { stdout: string }) => void
    mocks.git.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const old = load()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    _resetGitRemoteTopologySnapshotCache()
    await load()
    release({ stdout: 'old\thttps://github.com/old/repo (fetch)' })
    await old
    expect((await load()).remoteNames).toEqual(['fork'])
  })
  it('reprobes when a newly requested branch was absent from the cached snapshot', async () => {
    await load()
    mocks.git.mockImplementation(async (args) =>
      args[0] === 'for-each-ref'
        ? { stdout: 'refs/heads/new\0oid\0refs/remotes/fork/new' }
        : probe(args)
    )
    const snapshot = await getGitRemoteTopologySnapshot({ repoPath: '/repo', branchName: 'new' })
    expect(snapshot.upstreamRefs.get('new')).toBe('refs/remotes/fork/new')
  })
  it('preserves local-only upstream refs as distinct from remote ownership', async () => {
    mocks.git.mockImplementation(async (args) =>
      args[0] === 'for-each-ref'
        ? { stdout: 'refs/heads/feature\0oid\0refs/heads/main' }
        : probe(args)
    )
    expect((await load()).upstreamRefs.get('feature')).toBe('refs/heads/main')
  })
  it('rejects oversized remote inventories', async () => {
    mocks.git.mockImplementation(async (args) =>
      args[0] === 'remote'
        ? {
            stdout: Array.from(
              { length: 129 },
              (_, i) => `remote-${i}\thttps://github.com/a/r (fetch)`
            ).join('\n')
          }
        : probe(args)
    )
    await expect(load()).rejects.toThrow('too many remotes')
  })
  it('rejects oversized reference snapshots using the sentinel', async () => {
    mocks.git.mockImplementation(async (args) =>
      args[0] === 'for-each-ref'
        ? { stdout: Array.from({ length: 4097 }, (_, i) => `refs/heads/b-${i}\0oid\0`).join('\n') }
        : probe(args)
    )
    await expect(load()).rejects.toThrow('too many refs')
  })
  it('bounds multiple push URLs even for a single remote', async () => {
    mocks.git.mockImplementation(async (args) =>
      args[0] === 'remote'
        ? {
            stdout: Array.from(
              { length: 513 },
              (_, i) => `fork\thttps://github.com/a/r-${i} (push)`
            ).join('\n')
          }
        : probe(args)
    )
    await expect(load()).rejects.toThrow('too many URLs')
  })
})
