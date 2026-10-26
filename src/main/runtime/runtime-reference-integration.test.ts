import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  listWorktrees,
  listWorktreesStrict,
  listWorktreesSharedStrict
} from './orca-runtime-test-mocks.spec'
import { store, TEST_WORKTREE_ID } from './orca-runtime-test-fixtures.spec'
import { parseWorkspaceReferenceUrl } from '../../shared/workspace-reference-identity'
import type { RuntimeLinearCommands } from './runtime-linear-connection-commands'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

vi.mock('./agent-session-record-store-slot', () => ({
  peekOpenedAgentSessionRecordStore: () => null,
  openAgentSessionRecordStoreOnce: async () => ({
    store: { listConversations: () => [], getConversation: () => null }
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

class LinearOwnerRuntime extends OrcaRuntimeService {
  override listResolvedWorktrees(): Promise<ResolvedWorktree[]> {
    return Promise.resolve([])
  }
}

describe('Linear installed owner', () => {
  it('forwards the command promise unchanged', async () => {
    const runtime = new OrcaRuntimeService()
    const result: ReturnType<RuntimeLinearCommands['linearIssueComments']> = Promise.resolve([])
    const comments = vi.spyOn(runtime.linearCommands, 'linearIssueComments').mockReturnValue(result)
    expect(runtime.linearIssueComments('issue-1', 'workspace-1')).toBe(result)
    expect(comments).toHaveBeenCalledExactlyOnceWith('issue-1', 'workspace-1')
    await result
  })

  it('keeps terminal lookup late-bound after construction', async () => {
    const runtime = new OrcaRuntimeService(store)
    const first = vi.spyOn(runtime, 'showTerminal').mockRejectedValue(new Error('first hook'))
    await expect(
      runtime.linearResolveCurrentIssue({ terminalHandle: 'pane-1', remote: true })
    ).rejects.toMatchObject({ code: 'linear_issue_required' })
    expect(first).toHaveBeenCalledExactlyOnceWith('pane-1')
    first.mockRestore()
    const second = vi
      .spyOn(runtime, 'showTerminal')
      .mockRejectedValue(new Error('replacement hook'))
    await expect(
      runtime.linearResolveCurrentIssue({ terminalHandle: 'pane-2', remote: true })
    ).rejects.toMatchObject({ code: 'linear_issue_required' })
    expect(second).toHaveBeenCalledExactlyOnceWith('pane-2')
  })

  it('keeps worktree lookup late-bound and passes no arguments', async () => {
    const runtime = new LinearOwnerRuntime()
    const first = vi.spyOn(runtime, 'listResolvedWorktrees').mockResolvedValue([])
    await expect(runtime.resolveWorktreeForContainedPath(process.cwd())).resolves.toBeNull()
    expect(first).toHaveBeenCalledExactlyOnceWith()
    first.mockRestore()
    const second = vi.spyOn(runtime, 'listResolvedWorktrees').mockResolvedValue([])
    await expect(runtime.resolveWorktreeForContainedPath(process.cwd())).resolves.toBeNull()
    expect(second).toHaveBeenCalledExactlyOnceWith()
  })
})
