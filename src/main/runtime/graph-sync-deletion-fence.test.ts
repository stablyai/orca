/**
 * Deletion fence: a renderer snapshot that raced a worktree delete must not
 * resurrect the removed occupant's browser/terminal rows in a same-id
 * recreation, while the genuine successor is accepted promptly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import { OrcaRuntimeService } from './orca-runtime'

const WT = 'repo-1::/tmp/worktree-a'

const storeBase = {
  getRepo: () => ({
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }),
  getRepos: () => [storeBase.getRepo()],
  addRepo: () => {},
  updateRepo: () => undefined as never,
  getAllWorktreeMeta: () => ({}),
  getGitHubCache: () => ({ pr: {}, issue: {} }),
  setWorktreeMeta: () => undefined as never,
  getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
  addRetiredWorktreeName: () => {},
  mergeRetiredWorktreeNames: () => false,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: ''
  })
}

function makeRendererSnapshot(args: {
  version: number
  epoch?: string
}): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: WT,
    publicationEpoch: args.epoch ?? 'renderer:test-epoch',
    snapshotVersion: args.version,
    activeGroupId: 'group-1',
    activeTabId: 'tab-1::leaf-1',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'tab-1::leaf-1',
        parentTabId: 'tab-1',
        leafId: 'leaf-1',
        title: 'Terminal 1',
        isActive: true
      }
    ]
  }
}

type RuntimeInternals = {
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
}

describe('graph-sync deletion fence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  type FenceInternals = RuntimeInternals & {
    removedMobileSessionWorktreeIds: Map<string, unknown>
    removeWorktreeMetadataAndHistory: (store: unknown, worktreeId: string) => void
    rendererGeneration: string | null
  }

  function createFencedRuntime() {
    let meta: { instanceId: string; hostId?: string } | undefined = { instanceId: 'old-instance' }
    const store = {
      ...storeBase,
      getWorktreeMeta: () => meta,
      removeWorktreeMeta: () => {
        meta = undefined
      }
    }
    const runtime = new OrcaRuntimeService(store as never)
    const internals = runtime as unknown as FenceInternals
    const events: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
    const sync = (
      mobileSessionTabs: RuntimeMobileSessionTabsSnapshot[],
      extra: { rendererGeneration?: string; unchanged?: string[] } = {}
    ) =>
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        ...(extra.rendererGeneration ? { rendererGeneration: extra.rendererGeneration } : {}),
        mobileSessionTabs,
        ...(extra.unchanged ? { unchangedMobileSessionWorktrees: extra.unchanged } : {})
      } as never)
    const recreate = (instanceId: string): void => {
      meta = { instanceId }
    }
    const remove = (): void => internals.removeWorktreeMetadataAndHistory(store, WT)
    return { runtime, internals, events, sync, recreate, remove }
  }

  it("rejects the deleted occupant's late snapshot after same-id recreation", () => {
    const { internals, events, sync, recreate, remove } = createFencedRuntime()
    sync([{ ...makeRendererSnapshot({ version: 1 }), worktreeInstanceId: 'old-instance' }])
    vi.advanceTimersByTime(60)
    expect(internals.mobileSessionTabsByWorktree.has(WT)).toBe(true)
    events.length = 0

    remove()
    expect(events).toEqual([expect.objectContaining({ worktree: WT, removed: true })])
    events.length = 0
    recreate('new-instance')

    sync([{ ...makeRendererSnapshot({ version: 2 }), worktreeInstanceId: 'old-instance' }])
    vi.advanceTimersByTime(60)

    expect(internals.mobileSessionTabsByWorktree.has(WT)).toBe(false)
    expect(events).toHaveLength(0)
  })

  it("accepts the recreated occupant's snapshot and clears the fence", () => {
    const { internals, events, sync, recreate, remove } = createFencedRuntime()
    remove()
    events.length = 0
    recreate('new-instance')

    sync([{ ...makeRendererSnapshot({ version: 3 }), worktreeInstanceId: 'new-instance' }])
    vi.advanceTimersByTime(60)

    expect(internals.mobileSessionTabsByWorktree.has(WT)).toBe(true)
    expect(events).toEqual([expect.objectContaining({ worktree: WT, snapshotVersion: 3 })])
    expect(internals.removedMobileSessionWorktreeIds.has(WT)).toBe(false)
  })

  it('rejects a snapshot while the removed id has no successor metadata', () => {
    const { internals, events, sync, remove } = createFencedRuntime()
    remove()
    events.length = 0

    sync([{ ...makeRendererSnapshot({ version: 2 }), worktreeInstanceId: 'new-instance' }])
    vi.advanceTimersByTime(60)

    expect(internals.mobileSessionTabsByWorktree.has(WT)).toBe(false)
    expect(events).toHaveLength(0)
  })

  it('fences identity-less frames from the generation that published the deleted occupant', () => {
    const { internals, events, sync, recreate, remove } = createFencedRuntime()
    sync([makeRendererSnapshot({ version: 1, epoch: 'renderer:gen-1' })], {
      rendererGeneration: 'renderer:gen-1'
    })
    vi.advanceTimersByTime(60)
    remove()
    recreate('new-instance')
    events.length = 0

    sync([makeRendererSnapshot({ version: 2, epoch: 'renderer:gen-1' })], {
      rendererGeneration: 'renderer:gen-1'
    })
    vi.advanceTimersByTime(60)
    expect(internals.mobileSessionTabsByWorktree.has(WT)).toBe(false)
    expect(events).toHaveLength(0)

    // A reloaded renderer publishes a fresh generation; the resync-path throw
    // on a superseded generation needs the graph to leave 'ready' first.
    internals.rendererGeneration = null
    sync([makeRendererSnapshot({ version: 1, epoch: 'renderer:gen-2' })], {
      rendererGeneration: 'renderer:gen-2'
    })
    vi.advanceTimersByTime(60)
    expect(internals.mobileSessionTabsByWorktree.has(WT)).toBe(true)
  })

  it('does not request a resync for a fenced frame the renderer still lists as unchanged', () => {
    const { sync, recreate, remove } = createFencedRuntime()
    remove()
    recreate('new-instance')

    const first = sync([
      { ...makeRendererSnapshot({ version: 2 }), worktreeInstanceId: 'old-instance' }
    ])
    const second = sync([], { unchanged: [WT] })

    expect(first.mobileSessionResyncWorktrees ?? []).toEqual([])
    expect(second.mobileSessionResyncWorktrees ?? []).toEqual([])
  })
})
