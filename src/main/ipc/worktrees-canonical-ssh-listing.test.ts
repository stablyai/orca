import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hydrateRepo } from '../persistence/tracking-repos/repo-hydration'
import type { Repo } from '../../shared/repo-types'
import {
  getSshProviderAuthority,
  resetSshProviderAuthorities,
  rotateSshProviderAuthority
} from '../ssh/ssh-provider-authority'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args?: unknown) => unknown>(),
  provider: vi.fn(),
  remoteList: vi.fn(),
  git: vi.fn(),
  roots: vi.fn(),
  rootsRevision: vi.fn(),
  pruneLineage: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args?: unknown) => unknown) =>
      mocks.handlers.set(channel, handler)
  },
  app: { getPath: () => '/test' }
}))
vi.mock('../git/runner', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  gitExecFileAsync: mocks.git
}))
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: mocks.provider,
  getSshGitProviderGeneration: () => 1
}))
vi.mock('../project-runtime-git-options', () => ({ getLocalProjectWorktreeGitOptions: () => ({}) }))
vi.mock('./registered-worktree-roots-cache', () => ({
  getRegisteredWorktreeRootsRevision: mocks.rootsRevision,
  registerWorktreeRootsForRepo: mocks.roots
}))
vi.mock('../worktree-lineage-pruning', () => ({
  pruneLineageForMissingRepoWorktrees: mocks.pruneLineage
}))
vi.mock('./worktrees/listing/authoritative-local-worktree-metadata-pruning', () => ({
  pruneMetadataMissingFromAuthoritativeLocalScan: vi.fn()
}))
import { registerDetectedWorktreeHandlers } from './worktrees/listing/register-detected-worktree-handlers'
import { registerWorktreeCatalogHandlers } from './worktrees/listing/register-worktree-catalog-handlers'
import { registerHostCatalogHandlers } from './worktrees/listing/register-host-catalog-handlers'
import {
  __resetDetectedWorktreeScanCacheForTests,
  __getDetectedWorktreeScanCacheStatsForTests,
  invalidateDetectedWorktreeScanCache,
  listDetectedGitWorktrees,
  rememberLocalWorktreeRoots
} from './worktrees/listing/detected-worktree-scan-cache'

const path = '/remote/repository'
const rows = [{ path, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true }]
const channels = ['legacyDetected', 'hostDetected', 'list', 'listAll', 'known'] as const
function fixture(fields: Pick<Repo, 'connectionId' | 'executionHostId'>) {
  const repo = hydrateRepo(
    { id: 'repo', path, displayName: 'repo', badgeColor: '#000', addedAt: 0, ...fields },
    new Map()
  )
  const store = {
    getRepo: () => repo,
    getRepos: () => [repo],
    getProjects: () => [],
    getSettings: () => ({}),
    getAllWorktreeMeta: () => ({}),
    getProjectHostSetups: () => [],
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: vi.fn(),
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    removeWorktreeLineage: vi.fn(),
    captureNativeLocalWorktreeMetadataScanExpectation: () => undefined
  }
  const context = {
    store,
    detectedWorktreeCancellations: {
      begin: () => new AbortController(),
      finish: () => {},
      cancel: () => {}
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These handlers only use this store and request cancellation surface.
  registerDetectedWorktreeHandlers(context as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Catalog listing uses only the supplied store accessors.
  registerWorktreeCatalogHandlers(context as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Known-host reading uses only the supplied store accessors.
  registerHostCatalogHandlers(context as never)
  return { repo, store }
}
function invoke(channel: (typeof channels)[number]) {
  const hostArgs = {
    repoId: 'repo',
    executionHostId: 'ssh:host-a',
    providerRequestId: 'request',
    expectedAuthority: getSshProviderAuthority('host-a')
  }
  if (channel === 'legacyDetected') {
    return mocks.handlers.get('worktrees:listDetected')!(null, { repoId: 'repo' })
  }
  if (channel === 'hostDetected') {
    return mocks.handlers.get('worktrees:listDetected')!(null, hostArgs)
  }
  if (channel === 'known') {
    return mocks.handlers.get('worktrees:listKnownForExecutionHost')!(null, hostArgs)
  }
  return mocks.handlers.get(`worktrees:${channel}`)!(null, { repoId: 'repo' })
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.handlers.clear()
  __resetDetectedWorktreeScanCacheForTests()
  resetSshProviderAuthorities()
  mocks.provider.mockReturnValue({ listWorktrees: mocks.remoteList })
  mocks.remoteList.mockResolvedValue(rows)
  mocks.rootsRevision.mockReturnValue(1)
  mocks.git.mockRejectedValue(new Error('unexpected local Git'))
})

describe.each([
  { hostEncoding: 'canonical', fields: { executionHostId: 'ssh:host-a' as const } },
  { hostEncoding: 'legacy', fields: { connectionId: 'host-a' } }
])('$hostEncoding SSH listing', ({ fields }) => {
  it.each(channels)('keeps %s on the direct SSH boundary', async (channel) => {
    fixture(fields)
    const result = await invoke(channel)
    if (channel === 'known') {
      expect(result).toMatchObject({ status: 'complete', result: { authoritative: false } })
      expect(mocks.remoteList).not.toHaveBeenCalled()
    } else {
      expect(mocks.remoteList).toHaveBeenCalledTimes(1)
      expect(mocks.remoteList.mock.calls[0][0]).toBe(path)
      if (channel === 'hostDetected') {
        expect(result).toMatchObject({ status: 'complete', result: { authoritative: true } })
      } else if (channel === 'legacyDetected') {
        expect(result).toMatchObject({ authoritative: true })
      } else {
        expect(result).toHaveLength(1)
        expect(mocks.pruneLineage).toHaveBeenCalledTimes(1)
      }
    }
    expect(mocks.git).not.toHaveBeenCalled()
    expect(mocks.roots).not.toHaveBeenCalled()
    expect(__getDetectedWorktreeScanCacheStatsForTests()).toEqual({ cacheSize: 0, inFlightSize: 0 })
  })

  it('reports disconnection without replaying an authoritative local-cache answer', async () => {
    fixture(fields)
    await invoke('legacyDetected')
    mocks.provider.mockReturnValue(undefined)
    expect(await invoke('legacyDetected')).toMatchObject({ authoritative: false })
    expect(mocks.git).not.toHaveBeenCalled()
  })

  it('rejects a legacy listing after provider authority rotates', async () => {
    fixture(fields)
    let finish = (_rows: typeof rows): void => {}
    mocks.remoteList.mockReturnValue(
      new Promise<typeof rows>((resolve) => {
        finish = resolve
      })
    )
    const pending = invoke('legacyDetected')
    await Promise.resolve()
    rotateSshProviderAuthority('host-a')
    finish(rows)
    expect(await pending).toMatchObject({ authoritative: false })
    expect(mocks.roots).not.toHaveBeenCalled()
    expect(mocks.pruneLineage).not.toHaveBeenCalled()
  })

  it('bypasses local cache when the lower scan entry point is called directly', async () => {
    const { repo, store } = fixture(fields)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Remote scan bypass only needs the mocked Git options and provider.
    await listDetectedGitWorktrees(store as never, repo)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Remote scan bypass only needs the mocked Git options and provider.
    await listDetectedGitWorktrees(store as never, repo)
    expect(mocks.remoteList).toHaveBeenCalledTimes(2)
    expect(__getDetectedWorktreeScanCacheStatsForTests()).toEqual({ cacheSize: 0, inFlightSize: 0 })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: A remote row must return before reading the store.
    rememberLocalWorktreeRoots(store as never, repo, rows)
    expect(mocks.roots).not.toHaveBeenCalled()
  })

  it.each([
    ['list', 'mutation'],
    ['listAll', 'mutation'],
    ['list', 'roots revision'],
    ['listAll', 'roots revision']
  ] as const)('preserves lineage when %s is overtaken by a %s', async (channel, change) => {
    const { repo } = fixture(fields)
    let finish = (_rows: typeof rows): void => {}
    mocks.remoteList.mockReturnValue(
      new Promise<typeof rows>((resolve) => {
        finish = resolve
      })
    )
    const pending = invoke(channel)
    expect(mocks.remoteList).toHaveBeenCalledTimes(1)
    if (change === 'mutation') {
      invalidateDetectedWorktreeScanCache(repo.id)
    } else {
      mocks.rootsRevision.mockReturnValue(2)
    }
    finish(rows)
    expect(await pending).toHaveLength(1)
    expect(mocks.pruneLineage).not.toHaveBeenCalled()
    expect(mocks.roots).not.toHaveBeenCalled()
  })
})

it.each([undefined, 'nested'])(
  'keeps runtime rows out of local cache and root registration: %s',
  async (connectionId) => {
    const { repo, store } = fixture({ executionHostId: 'runtime:env', connectionId })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Runtime scan must reject before any listing or store side effects.
    await expect(listDetectedGitWorktrees(store as never, repo)).rejects.toThrow(
      'not reachable from this process'
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: A nonlocal row must return before reading the store.
    rememberLocalWorktreeRoots(store as never, repo, rows)
    expect(mocks.provider).not.toHaveBeenCalled()
    expect(mocks.git).not.toHaveBeenCalled()
    expect(mocks.roots).not.toHaveBeenCalled()
    expect(__getDetectedWorktreeScanCacheStatsForTests()).toEqual({ cacheSize: 0, inFlightSize: 0 })
  }
)
