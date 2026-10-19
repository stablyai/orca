import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hydrateRepo } from '../persistence/tracking-repos/repo-hydration'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { getSshProviderAuthority, resetSshProviderAuthorities } from '../ssh/ssh-provider-authority'
import { mergeWorktreeMetaForWrite } from '../persistence/loading-store/worktree-meta-write-normalization'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args?: unknown) => unknown>(),
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
  listDetectedGitWorktrees,
  rememberLocalWorktreeRoots
} from './worktrees/listing/detected-worktree-scan-cache'
import {
  hostWorktreeTarget,
  type HostWorktreeTarget
} from '../../shared/worktree/host-qualified-identity'

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
  mocks.rootsRevision.mockReturnValue(1)
  mocks.git.mockRejectedValue(new Error('unexpected local Git'))
})

describe.each([
  { hostEncoding: 'canonical', fields: { executionHostId: 'ssh:host-a' as const } },
  { hostEncoding: 'legacy', fields: { connectionId: 'host-a' } }
])('$hostEncoding SSH listing', ({ fields }) => {
  // An `ssh:` host is not served here: every channel answers from persisted metadata.
  it.each(channels)('answers %s from metadata, never from this machine', async (channel) => {
    fixture(fields)
    const result = await invoke(channel)
    if (channel === 'hostDetected') {
      expect(result).toMatchObject({
        status: 'non-authoritative',
        result: { authoritative: false }
      })
    } else if (channel === 'known') {
      expect(result).toMatchObject({ status: 'complete', result: { authoritative: false } })
    } else if (channel === 'legacyDetected') {
      expect(result).toMatchObject({ authoritative: false })
    } else {
      expect(result).toEqual([])
    }
    expect(mocks.git).not.toHaveBeenCalled()
    expect(mocks.roots).not.toHaveBeenCalled()
    expect(mocks.pruneLineage).not.toHaveBeenCalled()
    expect(__getDetectedWorktreeScanCacheStatsForTests()).toEqual({ cacheSize: 0, inFlightSize: 0 })
  })

  it('refuses the lower scan entry point instead of listing locally', async () => {
    const { repo, store } = fixture(fields)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The scan refuses before reading anything beyond the mocked Git options.
    await expect(listDetectedGitWorktrees(store as never, repo)).rejects.toThrow('not connected')
    expect(__getDetectedWorktreeScanCacheStatsForTests()).toEqual({ cacheSize: 0, inFlightSize: 0 })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: A remote row must return before reading the store.
    rememberLocalWorktreeRoots(store as never, repo, rows)
    expect(mocks.git).not.toHaveBeenCalled()
    expect(mocks.roots).not.toHaveBeenCalled()
  })
})

it.each(['git', 'folder'] as const)(
  'projects exact known SSH %s endpoints without building foreign repos',
  async (kind) => {
    const { repo, store } = fixture({ connectionId: 'host-a' })
    const parentInstance = '11111111-2222-3333-4444-555555555555'
    const parentPath = `/remote/parent::workspace:${parentInstance}`
    const parentRepo = hydrateRepo(
      {
        ...repo,
        id: 'parent-repo',
        kind,
        path: kind === 'folder' ? '/remote/parent' : parentPath,
        displayName: 'parent'
      },
      new Map()
    )
    const childId = 'repo::/remote/repository'
    const parentId = `parent-repo::${parentPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [childId]: mergeWorktreeMetaForWrite(undefined, {
        hostId: 'ssh:host-a',
        instanceId: 'child-instance',
        projectId: 'child-project'
      }),
      [parentId]: mergeWorktreeMetaForWrite(undefined, {
        hostId: 'ssh:host-a',
        instanceId: parentInstance,
        projectId: 'parent-project'
      })
    }
    if (kind === 'folder') {
      metaById[parentId].instanceId = undefined
    }
    store.setWorktreeMeta.mockImplementation(
      ({ id }: HostWorktreeTarget, updates: Partial<WorktreeMeta>) => {
        const meta = mergeWorktreeMetaForWrite(metaById[id], updates)
        metaById[id] = meta
        return meta
      }
    )
    Object.assign(store, {
      getRepos: () => [repo, parentRepo],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (id: string) => metaById[id],
      getAllWorktreeLineage: () => ({
        [childId]: {
          worktreeId: childId,
          worktreeInstanceId: 'child-instance',
          parentWorktreeId: parentId,
          parentWorktreeInstanceId: parentInstance,
          origin: 'cli',
          capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
          createdAt: 1
        }
      })
    })

    const child = await invoke('known')
    expect(child).toMatchObject({
      status: 'complete',
      result: { worktrees: [expect.objectContaining({ id: childId, parentWorktreeId: parentId })] }
    })
    expect(store.setWorktreeMeta).not.toHaveBeenCalledWith(
      hostWorktreeTarget({ id: parentId, hostId: 'local' }),
      expect.anything()
    )
    const parent = mocks.handlers.get('worktrees:listKnownForExecutionHost')!(null, {
      repoId: parentRepo.id,
      executionHostId: 'ssh:host-a'
    })
    expect(parent).toMatchObject({
      status: 'complete',
      result: {
        worktrees: [
          ...(kind === 'folder'
            ? [expect.objectContaining({ id: 'parent-repo::/remote/parent' })]
            : []),
          expect.objectContaining({ id: parentId, childWorktreeIds: [childId] })
        ]
      }
    })
  }
)

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
    expect(mocks.git).not.toHaveBeenCalled()
    expect(mocks.roots).not.toHaveBeenCalled()
    expect(__getDetectedWorktreeScanCacheStatsForTests()).toEqual({ cacheSize: 0, inFlightSize: 0 })
  }
)
