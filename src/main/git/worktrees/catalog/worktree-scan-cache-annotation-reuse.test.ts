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
  listWorktreesSharedStrict
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

  it('retains negative sparse answers for two large catalogs until reconciliation is due', async () => {
    const rows = Array.from({ length: 1492 }, (_, index) => ({
      ...ROW,
      path: `/synthetic/checkout-${index}`
    }))
    readWorktreeListMock.mockResolvedValue(rows)
    detectSparseCheckoutMock.mockResolvedValue(false)
    await listWorktreesSharedStrict('/synthetic/repo-a')
    await listWorktreesSharedStrict('/synthetic/repo-b')
    detectSparseCheckoutMock.mockResolvedValue(true)

    const first = await listWorktreesSharedStrict('/synthetic/repo-a')
    const second = await listWorktreesSharedStrict('/synthetic/repo-b')

    expect(first).toHaveLength(1492)
    expect(second).toHaveLength(1492)
    expect(first.every((row) => row.isSparse !== true)).toBe(true)
    expect(second.every((row) => row.isSparse !== true)).toBe(true)
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
