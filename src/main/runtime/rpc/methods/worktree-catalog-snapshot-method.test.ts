import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { WORKTREE_METHODS } from './worktree'
import { WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type {
  RuntimeWorktreePsResult,
  RuntimeWorktreePsSummary
} from '../../../../shared/runtime-types'

function makeRuntime(...rows: RuntimeWorktreePsSummary[]) {
  return runtimeReturning(
    ...rows.map((row) => ({ worktrees: [row], totalCount: 1, truncated: false }))
  )
}

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

describe('worktree.ps catalog snapshots', () => {
  it('gates source-default worktree projection by client capability', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
    await dispatcher.dispatchStreaming(
      {
        id: 'legacy',
        authToken: 'token',
        method: 'worktree.ps',
        params: { limit: 10_000 }
      },
      () => {},
      { clientCapabilities: [] }
    )
    await dispatcher.dispatchStreaming(
      {
        id: 'current',
        authToken: 'token',
        method: 'worktree.ps',
        params: { limit: 10_000, includeAgentWait: true }
      },
      () => {},
      { clientCapabilities: [WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY] }
    )
    await dispatcher.dispatchStreaming(
      {
        id: 'mobile',
        authToken: 'token',
        method: 'worktree.ps',
        params: { limit: 10_000, supportsWorktreeVisibilitySourceDefaults: true }
      },
      () => {},
      { clientCapabilities: [] }
    )

    expect(runtime.getWorktreePs).toHaveBeenNthCalledWith(1, 10_000, false, false)
    expect(runtime.getWorktreePs).toHaveBeenNthCalledWith(2, 10_000, true, true)
    expect(runtime.getWorktreePs).toHaveBeenNthCalledWith(3, 10_000, true, false)
  })
})

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

describe('worktree.ps snapshot polls', () => {
  // Same 30 s bucket, different chunk: only the per-chunk activity fields moved.
  const before = psRow({ lastOutputAt: 1_700_000_031_000, preview: 'step 1' })
  const after = psRow({ lastOutputAt: 1_700_000_039_000, preview: 'step 2' })

  it('keeps the snapshot id while only fine-grained activity changes', async () => {
    const dispatcher = new RpcDispatcher({
      runtime: makeRuntime(before, after),
      methods: WORKTREE_METHODS
    })
    const first = await poll(dispatcher, { limit: 10_000, afterSnapshotId: null })
    const second = await poll(dispatcher, { limit: 10_000, afterSnapshotId: first.snapshotId })

    expect(first.worktrees).toEqual([{ ...before, preview: '', lastOutputAt: 1_700_000_010_000 }])
    expect(second).toEqual({ unchanged: true, snapshotId: first.snapshotId })
  })

  it('still reports output that crosses a bucket boundary', async () => {
    const dispatcher = new RpcDispatcher({
      runtime: makeRuntime(before, psRow({ lastOutputAt: 1_700_000_071_000 })),
      methods: WORKTREE_METHODS
    })
    const first = await poll(dispatcher, { limit: 10_000, afterSnapshotId: null })
    const second = await poll(dispatcher, { limit: 10_000, afterSnapshotId: first.snapshotId })

    expect(second.snapshotId).not.toBe(first.snapshotId)
    expect(second.worktrees).toEqual([expect.objectContaining({ lastOutputAt: 1_700_000_070_000 })])
  })

  it('keeps the snapshot id while two active rows trade places inside one bucket', async () => {
    const a = (lastOutputAt: number) => psRow({ lastOutputAt })
    const b = (lastOutputAt: number) =>
      psRow({ lastOutputAt, worktreeId: 'repo-1::/w/b', path: '/w/b', displayName: 'b' })
    const runtime = runtimeReturning(
      { worktrees: [a(1_700_000_039_000), b(1_700_000_031_000)], totalCount: 2, truncated: false },
      { worktrees: [b(1_700_000_039_500), a(1_700_000_039_000)], totalCount: 2, truncated: false }
    )
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
    const first = await poll(dispatcher, { limit: 10_000, afterSnapshotId: null })
    const second = await poll(dispatcher, { limit: 10_000, afterSnapshotId: first.snapshotId })

    expect(second).toEqual({ unchanged: true, snapshotId: first.snapshotId })
  })

  it('returns byte-identical rows, preview included, to callers that do not poll snapshots', async () => {
    const dispatcher = new RpcDispatcher({
      runtime: makeRuntime(before),
      methods: WORKTREE_METHODS
    })

    expect(JSON.stringify(await poll(dispatcher, { limit: 10_000 }))).toBe(
      JSON.stringify({ worktrees: [before], totalCount: 1, truncated: false })
    )
  })
})

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
