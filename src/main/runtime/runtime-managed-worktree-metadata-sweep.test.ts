// Why this file exists: the authoritative missing-metadata prune had exactly one caller,
// `ipcMain.handle('worktrees:listAll')`. A headless runtime host has no renderer, so it never swept
// its own repos and their `worktreeMeta` rows grew without bound (#17776).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'
import { testState, createStore, makeRepo } from '../persistence-test-harness'
import type { Store } from '../persistence/loading-store/store'
import { RuntimeManagedWorktreeQueries } from './runtime-managed-worktree-queries'
import type { RuntimeStore } from './runtime-store-contract'

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
    scanRepo: async () => ({ ok, worktrees: [...worktrees] })
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
    store.setWorktreeMetaForHost(missingId, 'local', { displayName: 'Gone' })
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
    store.setWorktreeMetaForHost(liveId, 'local', { displayName: 'Live' })

    await queries(store, repo, [gitWorktree(repoPath)]).listDetected(repo)

    expect(store.getWorktreeMeta(liveId)).toBeDefined()
  })

  // A non-authoritative scan is a failed listing, which is no evidence any checkout is gone.
  it('keeps every row when the scan is not authoritative', async () => {
    const store = createStore()
    const repo = makeRepo({ id: 'repo-1', path: repoPath })
    store.addRepo(repo)
    const missingId = `${repo.id}::${join(testState.dir, 'deleted-worktree')}`
    store.setWorktreeMetaForHost(missingId, 'local', { displayName: 'Gone' })

    await queries(store, repo, [], false).listDetected(repo)

    expect(store.getWorktreeMeta(missingId)).toBeDefined()
  })

  // The execution host owns this verdict: this host cannot stat a checkout that lives behind an SSH
  // connection, so a local miss is not evidence of absence. See docs/reference/ssh-execution-boundary.md.
  //
  // Deliberately identical to the first case except for `connectionId`, and the row is stamped
  // `local` so it is a real prune candidate. That pairing is the proof: the same fixture without a
  // connection loses the row, so the connection is the only reason this one keeps it. Removing any
  // single gate would not show that -- four independent checks derive from `connectionId` here.
  it('never sweeps a repo whose git runs off-host', async () => {
    const store = createStore()
    const repo = makeRepo({ id: 'repo-1', path: repoPath, connectionId: 'build-box' })
    store.addRepo(repo)
    const missingId = `${repo.id}::${join(testState.dir, 'deleted-worktree')}`
    store.setWorktreeMetaForHost(missingId, 'local', { displayName: 'Gone' })

    await queries(store, repo, [gitWorktree(repoPath)]).listDetected(repo)

    expect(store.getWorktreeMeta(missingId)).toBeDefined()
  })
})
