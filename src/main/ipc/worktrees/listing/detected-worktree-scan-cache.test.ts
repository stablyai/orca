import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { Store } from '../../../persistence/loading-store/store'
import {
  invalidateWorktreeCatalogForRepo,
  peekWorktreeCatalog
} from '../../../workspaces/catalog/repo-worktree-catalog-owner'
import {
  forgetLocalWorktreeMetadataPruneGate,
  markLocalWorktreeMetadataPruneStarted
} from '../../../workspaces/catalog/local-worktree-metadata-prune-gate'
import { _resetSharedWorktreeAdminFingerprintProbesForTests } from '../../../runtime/workspaces/catalog/repo-worktree-admin-fingerprint'
import { listRepoWorktreesForDetectedScan } from '../../../workspaces/catalog/repo-worktrees'
import {
  DETECTED_WORKTREE_SCAN_CACHE_TTL_MS,
  listDetectedGitWorktrees
} from './detected-worktree-scan-cache'

vi.mock('../../../workspaces/catalog/repo-worktrees', () => ({
  listRepoWorktreesForDetectedScan: vi.fn()
}))

let tempDir = ''
let repoId = ''

function makeRepoFixture(id: string): { repo: Repo; gitDir: string } {
  repoId = id
  tempDir = mkdtempSync(path.join(tmpdir(), 'orca-desktop-scan-'))
  const repoDir = path.join(tempDir, 'repo')
  const gitDir = path.join(repoDir, '.git')
  mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true })
  writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(
    path.join(gitDir, 'refs', 'heads', 'main'),
    '1111111111111111111111111111111111111111\n'
  )
  return {
    repo: {
      id,
      path: repoDir,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 0,
      kind: 'git'
    },
    gitDir
  }
}

const fakeStore = {
  getRepos: () => [],
  getSettings: () => ({}),
  getProjectHostSetups: () => ({})
} as unknown as Store

describe('detected-worktree-scan-cache admin fingerprint verification', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    vi.mocked(listRepoWorktreesForDetectedScan).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (repoId) {
      invalidateWorktreeCatalogForRepo(repoId)
      forgetLocalWorktreeMetadataPruneGate(repoId)
      repoId = ''
    }
    _resetSharedWorktreeAdminFingerprintProbesForTests()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = ''
    }
  })

  it('reuses cached rows past the 5 s window when admin state is unchanged and rescans when a ref moves', async () => {
    const { repo, gitDir } = makeRepoFixture('desktop-verify-reuse')
    const scanMock = vi.mocked(listRepoWorktreesForDetectedScan)
    scanMock.mockResolvedValue([
      {
        path: repo.path,
        head: '1111111111111111111111111111111111111111',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])

    // Initial scan runs and populates the shared owner's adminFingerprint.
    const first = await listDetectedGitWorktrees(fakeStore, repo)
    expect(scanMock).toHaveBeenCalledTimes(1)
    expect(first.gitWorktrees).toHaveLength(1)
    const peeked = peekWorktreeCatalog(repo, 'local:default')
    expect(peeked?.observation.adminFingerprint).not.toBeNull()
    // Wait for the initial pre-scan admin probe to finish before testing steady-state verification.
    expect(await peeked?.observation.adminFingerprint).not.toBeNull()

    // Mark hygiene completed so steady-state refreshes can verify via admin fingerprint.
    markLocalWorktreeMetadataPruneStarted(repo.id)

    // Past the 5 s TTL with unchanged git admin state: verifier reuses rows without spawning git.
    vi.setSystemTime(1_000 + DETECTED_WORKTREE_SCAN_CACHE_TTL_MS + 10_000)
    const second = await listDetectedGitWorktrees(fakeStore, repo)
    expect(scanMock).toHaveBeenCalledTimes(1)
    expect(second.gitWorktrees).toHaveLength(1)

    // Move refs/heads/main and advance past TTL: verifier detects the change and runs git once.
    writeFileSync(
      path.join(gitDir, 'refs', 'heads', 'main'),
      '2222222222222222222222222222222222222222\n'
    )
    vi.setSystemTime(1_000 + DETECTED_WORKTREE_SCAN_CACHE_TTL_MS * 3 + 10_000)
    await listDetectedGitWorktrees(fakeStore, repo)
    expect(scanMock).toHaveBeenCalledTimes(2)
  })
})
