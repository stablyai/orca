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

import { __resetSparseCheckoutStateCacheForTests } from './worktree-sparse-checkout-cache'
import { listWorktreesStrict, listWorktreesUnshared } from './worktree-listing'

// Filesystem sparse probes need the same distro as the Git listing.
const ROW: GitWorktreeInfo = {
  path: 'C:\\wt\\x',
  head: 'a'.repeat(40),
  branch: 'refs/heads/feature',
  isBare: false,
  isMainWorktree: false
}

describe('worktree listing sparse annotation', () => {
  beforeEach(() => {
    detectSparseCheckoutMock.mockReset()
    detectSparseCheckoutMock.mockResolvedValue(false)
    readWorktreeListMock.mockReset()
    readWorktreeListMock.mockResolvedValue([ROW])
    readTranslatedWorktreeGraphMock.mockReset()
    readTranslatedWorktreeGraphMock.mockResolvedValue([ROW])
    // A warm sparse cache would bypass the probe under test.
    __resetSparseCheckoutStateCacheForTests()
  })

  it('passes the listing distro to the strict-list sparse probe', async () => {
    await listWorktreesStrict('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', { wslDistro: 'Ubuntu' })

    expect(detectSparseCheckoutMock).toHaveBeenCalledWith(
      'C:\\wt\\x',
      expect.objectContaining({ wslDistro: 'Ubuntu' })
    )
  })

  it('passes the listing distro to the unshared-list sparse probe', async () => {
    await listWorktreesUnshared('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', {
      wslDistro: 'Ubuntu'
    })

    expect(detectSparseCheckoutMock).toHaveBeenCalledWith(
      'C:\\wt\\x',
      expect.objectContaining({ wslDistro: 'Ubuntu' })
    )
  })
})
