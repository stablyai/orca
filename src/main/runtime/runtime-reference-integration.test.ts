import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  listWorktrees,
  listWorktreesStrict,
  listWorktreesSharedStrict
} from './orca-runtime-test-mocks.spec'
import { store, TEST_WORKTREE_ID } from './orca-runtime-test-fixtures.spec'
import { parseWorkspaceReferenceUrl } from '../../shared/workspace-reference-identity'

vi.mock('./agent-session-record-store-slot', () => ({
  peekOpenedAgentSessionRecordStore: () => null,
  openAgentSessionRecordStoreOnce: async () => ({
    store: { listRecords: () => [], getRecord: () => null }
  })
}))

const linear = 'https://linear.app/acme/issue/STA-1234'

afterEach(() => vi.restoreAllMocks())

function setup(Runtime: typeof OrcaRuntimeService = OrcaRuntimeService) {
  const base = store.getAllWorktreeMeta()[TEST_WORKTREE_ID]
  const linkedItems = [parseWorkspaceReferenceUrl(linear)]
  const runtimeStore = {
    ...store,
    getAllWorktreeMeta: () => ({
      [TEST_WORKTREE_ID]: { ...base, linkedItems },
      'repo-2::/elsewhere': { ...base, displayName: 'other', linkedItems }
    }),
    getRepos: () => [
      ...store.getRepos(),
      { id: 'repo-2', path: '/elsewhere', displayName: 'other', badgeColor: '', addedAt: 0 }
    ]
  }
  vi.mocked(listWorktrees).mockClear()
  vi.mocked(listWorktreesStrict).mockClear()
  vi.mocked(listWorktreesSharedStrict).mockClear()
  return new Runtime(runtimeStore)
}

describe('reference find runtime integration', () => {
  it('searches cold saved metadata across repos without a Git scan', async () => {
    const runtime = setup()
    const result = await runtime.findWorkspaceReferences({ query: 'STA-1234' })
    expect(result.matches.map(({ workspace }) => workspace.id)).toEqual([
      TEST_WORKTREE_ID,
      'repo-2::/elsewhere'
    ])
    expect(listWorktrees).not.toHaveBeenCalled()
    expect(listWorktreesStrict).not.toHaveBeenCalled()
    expect(listWorktreesSharedStrict).not.toHaveBeenCalled()
  })

  it('filters explicit repo and workspace selectors without populating the Git cache', async () => {
    const runtime = setup()
    expect(
      (await runtime.findWorkspaceReferences({ query: linear, repo: 'id:repo-2' })).matches.map(
        ({ workspace }) => workspace.id
      )
    ).toEqual(['repo-2::/elsewhere'])
    expect(
      (await runtime.findWorkspaceReferences({ query: linear, worktree: 'name:foo' })).matches.map(
        ({ workspace }) => workspace.id
      )
    ).toEqual([TEST_WORKTREE_ID])
    expect(listWorktrees).not.toHaveBeenCalled()
    expect(listWorktreesStrict).not.toHaveBeenCalled()
    expect(listWorktreesSharedStrict).not.toHaveBeenCalled()
  })

  it('warms the worktree cache when a branch selector misses cold metadata', async () => {
    const discovered = {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'refs/heads/feat',
      isBare: false,
      isMainWorktree: false
    }
    class ScannedRuntime extends OrcaRuntimeService {
      protected override async listRepoWorktreesForResolution(repo: { id: string }) {
        return { ok: true as const, worktrees: repo.id === 'repo-2' ? [] : [discovered] }
      }
    }
    const runtime = setup(ScannedRuntime)
    const result = await runtime.findWorkspaceReferences({ query: linear, worktree: 'branch:feat' })
    expect(result.matches.map(({ workspace }) => workspace.id)).toEqual([TEST_WORKTREE_ID])
  })
})
