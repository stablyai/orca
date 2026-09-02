// The annotated listing is the graph listing plus a sparse probe: callers that read only
// `worktree.path` must skip the probe, without costing a second `git worktree list`.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitWorktreeInfo } from '../../shared/worktree/types'

const { detectSparseCheckoutMock, readWorktreeListMock, readTranslatedWorktreeGraphMock } =
  vi.hoisted(() => ({
    detectSparseCheckoutMock: vi.fn(),
    readWorktreeListMock: vi.fn(),
    readTranslatedWorktreeGraphMock: vi.fn()
  }))

vi.mock('./worktree-sparse-state', () => ({
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

import { _resetWorktreeScanCacheForTests, listWorktreeGraph, listWorktrees } from './worktree'
import { __resetSparseCheckoutStateCacheForTests } from './worktree-sparse-checkout-cache'

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

  it('still probes sparse state for the annotated scan', async () => {
    const rows = await listWorktrees(REPO, { wslDistro: 'Ubuntu' })

    expect(rows[0]?.isSparse).toBe(true)
    expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(1)
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

  // Sharing the listing must not make the probe-free caller wait on the probe it opted out of.
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
