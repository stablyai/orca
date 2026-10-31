// Headless hosts lack the old worktrees:listAll IPC sweep; runtime must prune its own missing metadata or rows grow unbounded (#17776).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'
import { testState, createStore, makeRepo } from '../persistence/persistence-test-harness'
import type { Store } from '../persistence/loading-store/store'
import { RuntimeManagedWorktreeQueries } from './runtime-managed-worktree-queries'
import type { RuntimeStore } from './runtime-store-contract'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn().mockReturnValue({}) }))

const gitWorktree = (path: string): GitWorktreeInfo => ({
  path,
  branch: 'main',
  head: 'abc1234',
  isBare: false,
  isMainWorktree: true
})

function queries(
  store: Store,
  repo: Repo,
  worktrees: readonly GitWorktreeInfo[],
  ok = true
): RuntimeManagedWorktreeQueries {
  return new RuntimeManagedWorktreeQueries({
    getStore: () => store as unknown as RuntimeStore,
    listResolved: async () => [],
    resolveRepo: async () => repo,
    selectRepos: () => [repo],
    scanRepo: async () => ({ ok, worktrees: [...worktrees] }),
    listKnownHostIds: () => []
  })
}

describe('runtime detected-worktree listing sweeps missing local metadata', () => {
  let repoPath = ''

  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-runtime-sweep-'))
    repoPath = join(testState.dir, 'repo')
    mkdirSync(repoPath, { recursive: true })
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  // Paired with the off-host case below: same fixture, no `connectionId`.
  it('drops a metadata row whose directory is gone and the scan does not list', async () => {
    const store = createStore()
    const repo = makeRepo({ id: 'repo-1', path: repoPath })
    store.addRepo(repo)
    const missingId = `${repo.id}::${join(testState.dir, 'deleted-worktree')}`
    store.setWorktreeMeta(hostWorktreeTarget({ id: missingId, hostId: 'local' }), {
      displayName: 'Gone'
    })
    expect(store.getWorktreeMeta(missingId)).toBeDefined()

    await queries(store, repo, [gitWorktree(repoPath)]).listDetected(repo)

    expect(store.getWorktreeMeta(missingId)).toBeUndefined()
  })

  it('keeps a row whose directory still exists', async () => {
    const store = createStore()
    const repo = makeRepo({ id: 'repo-1', path: repoPath })
    store.addRepo(repo)
    const livePath = join(testState.dir, 'live-worktree')
    mkdirSync(livePath, { recursive: true })
    const liveId = `${repo.id}::${livePath}`
    store.setWorktreeMeta(hostWorktreeTarget({ id: liveId, hostId: 'local' }), {
      displayName: 'Live'
    })

    await queries(store, repo, [gitWorktree(repoPath)]).listDetected(repo)

    expect(store.getWorktreeMeta(liveId)).toBeDefined()
  })

  // A non-authoritative scan is a failed listing, which is no evidence any checkout is gone.
  it('keeps every row when the scan is not authoritative', async () => {
    const store = createStore()
    const repo = makeRepo({ id: 'repo-1', path: repoPath })
    store.addRepo(repo)
    const missingId = `${repo.id}::${join(testState.dir, 'deleted-worktree')}`
    store.setWorktreeMeta(hostWorktreeTarget({ id: missingId, hostId: 'local' }), {
      displayName: 'Gone'
    })

    await queries(store, repo, [], false).listDetected(repo)

    expect(store.getWorktreeMeta(missingId)).toBeDefined()
  })

  // Only execution hosts may prove checkout absence (docs/reference/ssh-execution-boundary.md).
  // Match the first fixture except connectionId: the connected case retains its local-stamped candidate, isolating that boundary despite four derived gates.
  it('never sweeps a repo whose git runs off-host', async () => {
    const store = createStore()
    const repo = makeRepo({ id: 'repo-1', path: repoPath, connectionId: 'build-box' })
    store.addRepo(repo)
    const missingId = `${repo.id}::${join(testState.dir, 'deleted-worktree')}`
    store.setWorktreeMeta(hostWorktreeTarget({ id: missingId, hostId: 'local' }), {
      displayName: 'Gone'
    })

    await queries(store, repo, [gitWorktree(repoPath)]).listDetected(repo)

    expect(store.getWorktreeMeta(missingId)).toBeDefined()
  })
})
