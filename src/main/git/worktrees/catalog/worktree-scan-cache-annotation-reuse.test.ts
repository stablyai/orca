// Probe-free graph readers share the Git listing without waiting for sparse annotation.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'

const { detectSparseCheckoutMock, readWorktreeListMock, readTranslatedWorktreeGraphMock } =
  vi.hoisted(() => ({
    detectSparseCheckoutMock: vi.fn(),
    readWorktreeListMock: vi.fn(),
    readTranslatedWorktreeGraphMock: vi.fn()
  }))

vi.mock('../sparse-checkout/worktree-sparse-state', () => ({
  detectSparseCheckout: detectSparseCheckoutMock,
  resolveGitCommonDir: vi.fn()
}))
vi.mock('./worktree-list-reader', () => ({
  readCheckedOutBranchRef: vi.fn(),
  readRepoCommonDirFromGit: vi.fn(),
  readRepoLocation: vi.fn(),
  readTranslatedWorktreeGraph: readTranslatedWorktreeGraphMock,
  readWorktreeHeadOid: vi.fn(),
  readWorktreeList: readWorktreeListMock
}))

import {
  _resetWorktreeScanCacheForTests,
  listWorktreeGraph,
  listWorktrees,
  listWorktreesSharedStrict,
  listWorktreeGraphSharedStrict,
  bumpWorktreeScanGeneration
} from './worktree-scan-cache'
import { __resetSparseCheckoutStateCacheForTests } from '../sparse-checkout/worktree-sparse-checkout-cache'

const REPO = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
const ROW: GitWorktreeInfo = {
  path: 'C:\\wt\\x',
  head: 'a'.repeat(40),
  branch: 'refs/heads/feature',
  isBare: false,
  isMainWorktree: false
}

describe('graph and annotated worktree scans', () => {
  beforeEach(() => {
    detectSparseCheckoutMock.mockReset()
    detectSparseCheckoutMock.mockResolvedValue(true)
    readWorktreeListMock.mockReset()
    readWorktreeListMock.mockResolvedValue([ROW])
    readTranslatedWorktreeGraphMock.mockReset()
    readTranslatedWorktreeGraphMock.mockResolvedValue([ROW])
    _resetWorktreeScanCacheForTests()
    __resetSparseCheckoutStateCacheForTests()
  })

  it('does not probe sparse state for a graph scan', async () => {
    const rows = await listWorktreeGraph(REPO, { wslDistro: 'Ubuntu' })

    expect(rows[0]?.path).toBe('C:\\wt\\x')
    expect(rows[0]?.isSparse).toBeUndefined()
    expect(detectSparseCheckoutMock).not.toHaveBeenCalled()
  })

  it('reads the git listing once for an overlapping graph and annotated scan', async () => {
    const [graphRows, annotatedRows] = await Promise.all([
      listWorktreeGraph(REPO, { wslDistro: 'Ubuntu' }),
      listWorktrees(REPO, { wslDistro: 'Ubuntu' })
    ])

    expect(readTranslatedWorktreeGraphMock).toHaveBeenCalledTimes(1)
    expect(graphRows[0]?.isSparse).toBeUndefined()
    expect(annotatedRows[0]?.isSparse).toBe(true)
  })

  it('resolves a graph scan while the annotated scan is still probing', async () => {
    let releaseProbe!: () => void
    detectSparseCheckoutMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseProbe = () => resolve(true)
        })
    )

    const annotatedScan = listWorktrees(REPO, { wslDistro: 'Ubuntu' })
    const graphRows = await listWorktreeGraph(REPO, { wslDistro: 'Ubuntu' })

    expect(graphRows[0]?.path).toBe('C:\\wt\\x')
    releaseProbe()
    expect((await annotatedScan)[0]?.isSparse).toBe(true)
  })
})

it('shares only matching live cancellation scopes and preserves generation freshness', async () => {
  _resetWorktreeScanCacheForTests()
  readWorktreeListMock.mockReset()
  __resetSparseCheckoutStateCacheForTests()
  const pending = Promise.withResolvers<GitWorktreeInfo[]>()
  readWorktreeListMock.mockReturnValue(pending.promise)
  detectSparseCheckoutMock.mockResolvedValue(false)
  const first = new AbortController()
  const other = new AbortController()
  const reads = [
    listWorktreesSharedStrict('/repo', { signal: first.signal }),
    listWorktreesSharedStrict('/repo', { signal: first.signal }),
    listWorktreesSharedStrict('/repo', { signal: other.signal }),
    listWorktreesSharedStrict('/repo')
  ]
  expect(readWorktreeListMock).toHaveBeenCalledTimes(3)
  bumpWorktreeScanGeneration('/repo')
  reads.push(listWorktreesSharedStrict('/repo', { signal: first.signal }))
  expect(readWorktreeListMock).toHaveBeenCalledTimes(4)
  first.abort()
  await expect(listWorktreesSharedStrict('/repo', { signal: first.signal })).rejects.toThrow()
  expect(readWorktreeListMock).toHaveBeenCalledTimes(4)
  pending.resolve([])
  const outcomes = await Promise.allSettled(reads)
  expect(outcomes.map((outcome) => outcome.status)).toEqual([
    'rejected',
    'rejected',
    'fulfilled',
    'fulfilled',
    'rejected'
  ])
})

it('keeps strict all-row graphs separate, preserves errors and refreshes in the same cancellation scope', async () => {
  _resetWorktreeScanCacheForTests()
  readTranslatedWorktreeGraphMock.mockReset()
  const pending = Promise.withResolvers<GitWorktreeInfo[]>()
  readTranslatedWorktreeGraphMock.mockReturnValue(pending.promise)
  const signal = new AbortController().signal
  const scans = [
    listWorktreeGraphSharedStrict('/repo', { signal }),
    listWorktreeGraphSharedStrict('/repo', { signal })
  ]
  expect(readTranslatedWorktreeGraphMock).toHaveBeenCalledOnce()
  scans.push(listWorktreeGraph('/repo', { signal }))
  expect(readTranslatedWorktreeGraphMock).toHaveBeenCalledTimes(2)
  bumpWorktreeScanGeneration('/repo')
  scans.push(listWorktreeGraphSharedStrict('/repo', { signal }))
  expect(readTranslatedWorktreeGraphMock).toHaveBeenCalledTimes(3)
  const nested = {
    ...ROW,
    path: '/repo/checkout/.orca-worktree-preparation',
    branch: 'refs/heads/orca-create-preparation/test'
  }
  pending.resolve([ROW, nested])
  expect((await Promise.all(scans))[0]).toEqual([ROW, nested])
  const failure = new Error('inventory unavailable')
  readTranslatedWorktreeGraphMock.mockRejectedValueOnce(failure)
  await expect(listWorktreeGraphSharedStrict('/repo', { signal })).rejects.toBe(failure)
})
