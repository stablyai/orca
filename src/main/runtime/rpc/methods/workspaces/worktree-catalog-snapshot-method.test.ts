import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { RpcDispatcher } from '../../dispatcher'
import { WORKTREE_METHODS } from './worktree'
import '../../../../../shared/protocol-version'
import '../../../../../shared/worktree-runtime-capabilities'
import type {
  RuntimeWorktreePsResult,
  RuntimeWorktreePsSummary
} from '../../../../../shared/runtime-worktree-contracts'

function runtimeReturning(...results: RuntimeWorktreePsResult[]) {
  const getWorktreePs = vi.fn().mockResolvedValue({
    worktrees: [],
    totalCount: 0,
    truncated: false
  })
  for (const result of results) {
    getWorktreePs.mockResolvedValueOnce(result)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worktree.ps reads only these two runtime members.
  return { getRuntimeId: () => 'test-runtime', getWorktreePs } as unknown as OrcaRuntimeService
}

function psRow(overrides: Partial<RuntimeWorktreePsSummary> = {}): RuntimeWorktreePsSummary {
  return {
    worktreeId: 'repo-1::/w/a',
    repoId: 'repo-1',
    repo: 'repo',
    path: '/w/a',
    branch: 'feature',
    isArchived: false,
    isMainWorktree: false,
    hasHostSidebarActivity: true,
    parentWorktreeId: null,
    childWorktreeIds: [],
    displayName: 'a',
    workspaceStatus: 'in-progress',
    sortOrder: 0,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    comment: '',
    isPinned: false,
    isActive: false,
    unread: false,
    liveTerminalCount: 1,
    hasAttachedPty: true,
    lastOutputAt: 1_700_000_031_000,
    preview: 'building…',
    status: 'working',
    agents: [],
    ...overrides
  }
}

async function poll(
  dispatcher: RpcDispatcher,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await dispatcher.dispatch({
    id: 'poll',
    authToken: 'token',
    method: 'worktree.ps',
    params
  })
  if (!response.ok || typeof response.result !== 'object' || response.result === null) {
    throw new Error(`worktree.ps failed: ${JSON.stringify(response)}`)
  }
  return { ...response.result }
}

describe('worktree.ps row deltas', () => {
  const a = psRow({ worktreeId: 'repo-1::/w/a', displayName: 'a' })
  const b = psRow({ worktreeId: 'repo-1::/w/b', displayName: 'b' })
  const c = psRow({ worktreeId: 'repo-1::/w/c', displayName: 'c' })
  const catalog = (...worktrees: RuntimeWorktreePsSummary[]): RuntimeWorktreePsResult => ({
    worktrees,
    totalCount: worktrees.length,
    truncated: false
  })

  it('sends rows the caller holds as indexes into its base catalog', async () => {
    const renamed = psRow({ worktreeId: 'repo-1::/w/b', displayName: 'b2' })
    const dispatcher = new RpcDispatcher({
      runtime: runtimeReturning(catalog(a, b, c), catalog(c, renamed, a)),
      methods: WORKTREE_METHODS
    })
    const base = await poll(dispatcher, { limit: 10_000, afterSnapshotId: null })
    const delta = await poll(dispatcher, {
      limit: 10_000,
      afterSnapshotId: base.snapshotId,
      acceptRowDelta: true
    })

    expect(delta).toMatchObject({ baseSnapshotId: base.snapshotId, totalCount: 3 })
    expect(delta.rowsFromBase).toEqual([
      2,
      { ...renamed, preview: '', lastOutputAt: 1_700_000_010_000 },
      0
    ])
    expect(delta).not.toHaveProperty('worktrees')
  })

  it('answers a full catalog to callers that did not opt in or hold an unknown base', async () => {
    const dispatcher = new RpcDispatcher({
      runtime: runtimeReturning(catalog(a), catalog(a, b), catalog(a, b, c)),
      methods: WORKTREE_METHODS
    })
    const base = await poll(dispatcher, { limit: 10_000, afterSnapshotId: null })

    const optedOut = await poll(dispatcher, { limit: 10_000, afterSnapshotId: base.snapshotId })
    const unknownBase = await poll(dispatcher, {
      limit: 10_000,
      afterSnapshotId: 'evicted',
      acceptRowDelta: true
    })

    expect(optedOut.worktrees).toHaveLength(2)
    expect(unknownBase.worktrees).toHaveLength(3)
  })
})
