import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'

const { listRepoWorktreesMock } = vi.hoisted(() => ({ listRepoWorktreesMock: vi.fn() }))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  app: { getPath: () => '/tmp/orca-test' }
}))
vi.mock('../../../workspaces/catalog/repo-worktrees', () => ({
  listRepoWorktreesForDetectedScan: listRepoWorktreesMock
}))
vi.mock('../../../workspaces/execution-host/project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: () => ({})
}))
vi.mock('../removal/registered-worktree-roots-cache', () => ({
  getRegisteredWorktreeRootsRevision: () => 1,
  registerWorktreeRootsForRepo: vi.fn()
}))
vi.mock('../../../workspaces/catalog/worktree-lineage-pruning', () => ({
  pruneLineageForMissingRepoWorktrees: vi.fn()
}))
vi.mock('./authoritative-local-worktree-metadata-pruning', () => ({
  pruneMetadataMissingFromAuthoritativeLocalScan: vi
    .fn()
    .mockResolvedValue({ scanGenerationCurrent: true, preservedMetadataCandidateIds: new Set() })
}))

const { listDetectedWorktreesForCapturedRepo } = await import('./detected-provider-listing')
const { __resetDetectedWorktreeScanCacheForTests } = await import('./detected-worktree-scan-cache')
await import('../../../workspaces/catalog/local-worktree-scan-generation')

const localRepo: Repo = {
  id: 'repo-local',
  path: '/repos/local',
  displayName: 'local',
  badgeColor: '#000',
  addedAt: 0
}

function createStore(repo: Repo, cursor?: { epoch: string; seq: number }) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listing reads only these store methods; the pruning that would need more is mocked above.
  return {
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
    captureNativeLocalWorktreeMetadataScanExpectation: () => undefined,
    ...(cursor ? { getWorkspaceMetadataCursor: () => ({ ...cursor }) } : {})
  } as never
}

function worktreeAt(repo: Repo, path: string): GitWorktreeInfo {
  return { path, head: 'abc', branch: 'main', isBare: false, isMainWorktree: path === repo.path }
}

// Clients order listing rows by scan-start generation against applied create/remove replies.
describe('the catalog version a listing carries', () => {
  beforeEach(() => {
    __resetDetectedWorktreeScanCacheForTests()
    listRepoWorktreesMock.mockReset()
  })

  it('carries the metadata cursor it read with its metadata, not one advanced during the scan', async () => {
    const cursor = { epoch: 'e1', seq: 4 }
    // A title write lands while the scan is still running.
    listRepoWorktreesMock.mockImplementation(async () => {
      cursor.seq = 5
      return [worktreeAt(localRepo, localRepo.path)]
    })
    const store = createStore(localRepo, cursor)

    const during = await listDetectedWorktreesForCapturedRepo(store, localRepo, () => true)
    const after = await listDetectedWorktreesForCapturedRepo(store, localRepo, () => true)

    expect(during && 'workspaceMetadata' in during ? during.workspaceMetadata : null).toEqual({
      epoch: 'e1',
      seq: 4
    })
    expect(after && 'workspaceMetadata' in after ? after.workspaceMetadata : null).toEqual({
      epoch: 'e1',
      seq: 5
    })
  })
})
