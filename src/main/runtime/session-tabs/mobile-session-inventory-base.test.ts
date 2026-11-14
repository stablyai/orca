/** A renderer frame may name its accepted inventory instead of resending it; anything but that exact base resyncs. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPageInventoryEntry } from '../../../shared/browser/runtime/browser-page-inventory'
import { browserPageInventorySchema } from '../../../shared/browser/runtime/browser-page-inventory'
import type {
  RuntimeMobileSessionTabsPublication,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-session-contracts'
import { OrcaRuntimeService } from '../orca-runtime'

const WT = 'repo-1::/tmp/worktree-inventory'
const EPOCH = 'renderer:inventory-epoch'

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

function entry(id: string): BrowserPageInventoryEntry {
  return {
    browserPageId: id,
    browserWorkspaceId: 'browser-1',
    title: `Page ${id}`,
    url: `https://${id}.example/`,
    profileId: 'default',
    loadError: null,
    certificateFailure: null
  }
}

function frame(
  version: number,
  extra: Partial<RuntimeMobileSessionTabsPublication> = {}
): RuntimeMobileSessionTabsPublication {
  return {
    worktree: WT,
    worktreeInstanceId: 'occupant-1',
    publicationEpoch: EPOCH,
    snapshotVersion: version,
    activeGroupId: null,
    activeTabId: 'tab-1::leaf-1',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'tab-1::leaf-1',
        parentTabId: 'tab-1',
        leafId: 'leaf-1',
        title: `Terminal v${version}`,
        isActive: true
      }
    ],
    ...extra
  }
}

type Internals = {
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  acceptedRendererMobileSnapshotByWorktree: Map<string, { rendererVersion: number }>
  removeWorktreeMetadataAndHistory: (store: unknown, worktreeId: string) => void
  releaseRuntimeSessionOwnershipForRendererRetiredTabs: (...args: unknown[]) => void
  nativeChatDraftResolutions: { reconcile: (...args: unknown[]) => void }
}

function createRuntime() {
  let meta: { instanceId: string } | undefined = { instanceId: 'occupant-1' }
  const store = {
    ...storeBase,
    getWorktreeMeta: () => meta,
    removeWorktreeMeta: () => {
      meta = undefined
    }
  }
  const runtime = new OrcaRuntimeService(store as never)
  const internals = runtime as unknown as Internals
  const events: RuntimeMobileSessionTabsResult[] = []
  runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
  const sync = (...frames: RuntimeMobileSessionTabsPublication[]) =>
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: frames })
  const stored = () => internals.mobileSessionTabsByWorktree.get(WT)
  return {
    runtime,
    internals,
    events,
    sync,
    stored,
    accepted: () => internals.acceptedRendererMobileSnapshotByWorktree.get(WT),
    recreate: (instanceId: string) => {
      meta = { instanceId }
    },
    remove: () => internals.removeWorktreeMetadataAndHistory(store, WT)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('acknowledged browser page inventory base', () => {
  it('reuses the accepted inventory by reference past main-local bumps and strips the base', () => {
    const { runtime, events, sync, stored } = createRuntime()
    const inventory = [entry('a'), entry('b'), entry('c')]
    sync(frame(1, { browserPageInventory: inventory }))
    // Graph-only changes advance main's stored version, never the renderer's accepted one.
    runtime.storeMobileSessionSnapshot(WT, {
      ...stored()!,
      snapshotVersion: stored()!.snapshotVersion + 5
    })
    const validate = vi.spyOn(browserPageInventorySchema, 'safeParse')
    events.length = 0

    const result = sync(frame(2, { browserPageInventoryBaseVersion: 1 }))
    vi.advanceTimersByTime(60)

    expect(result.mobileSessionResyncWorktrees).toBeUndefined()
    expect(validate).not.toHaveBeenCalled()
    expect(stored()!.tabs[0]).toMatchObject({ title: 'Terminal v2' })
    expect(stored()!.browserPageInventory).toBe(inventory)
    expect(stored()!.browserPageInventory!.map((page) => page.title)).toEqual([
      'Page a',
      'Page b',
      'Page c'
    ])
    expect(stored()).not.toHaveProperty('browserPageInventoryBaseVersion')
    expect(events).toHaveLength(1)
    expect(events[0]).not.toHaveProperty('browserPageInventoryBaseVersion')
    expect(events[0]).not.toHaveProperty('browserPageInventory')

    // A chain of terminal-only frames keeps naming the latest accepted base.
    sync(frame(3, { browserPageInventoryBaseVersion: 2 }))
    expect(stored()!.tabs[0]).toMatchObject({ title: 'Terminal v3' })
    expect(stored()!.browserPageInventory).toBe(inventory)
  })

  it('replaces with a full array, including an authoritative empty inventory, and reuses that', () => {
    const { sync, stored } = createRuntime()
    sync(frame(1, { browserPageInventory: [entry('a'), entry('b')] }))
    sync(frame(2, { browserPageInventory: [] }))
    expect(stored()!.browserPageInventory).toEqual([])

    expect(
      sync(frame(3, { browserPageInventoryBaseVersion: 2 })).mobileSessionResyncWorktrees
    ).toBeUndefined()
    expect(stored()!.browserPageInventory).toEqual([])
    expect(stored()!.tabs[0]).toMatchObject({ title: 'Terminal v3' })
  })

  it.each([
    ['a wrong base', frame(3, { browserPageInventoryBaseVersion: 1 })],
    [
      'another publication epoch',
      frame(3, { publicationEpoch: 'renderer:reloaded', browserPageInventoryBaseVersion: 2 })
    ],
    [
      'another occupant',
      frame(3, { worktreeInstanceId: 'occupant-2', browserPageInventoryBaseVersion: 2 })
    ]
  ])('keeps state and requests a full frame for %s', (_label, mismatched) => {
    const { internals, sync, stored, accepted } = createRuntime()
    const inventory = [entry('a'), entry('b')]
    sync(frame(1, { browserPageInventory: [entry('old')] }))
    sync(frame(2, { browserPageInventory: inventory }))
    const before = stored()
    const reconcile = vi.spyOn(internals.nativeChatDraftResolutions, 'reconcile')
    const release = vi.spyOn(internals, 'releaseRuntimeSessionOwnershipForRendererRetiredTabs')

    expect(sync(mismatched).mobileSessionResyncWorktrees).toEqual([WT])

    expect(stored()).toBe(before)
    expect(stored()!.browserPageInventory).toBe(inventory)
    expect(accepted()).toBeUndefined()
    expect(reconcile).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    // The renderer's full resend of the same version now passes the dropped accept gate.
    const { browserPageInventoryBaseVersion: _base, ...full } = mismatched
    expect(
      sync({ ...full, browserPageInventory: [entry('z')] }).mobileSessionResyncWorktrees
    ).toBeUndefined()
    expect(stored()!.browserPageInventory!.map((page) => page.browserPageId)).toEqual(['z'])
    expect(accepted()?.rendererVersion).toBe(mismatched.snapshotVersion)
  })

  it('re-merges the exact accepted revision only from a full frame', () => {
    const { internals, sync, stored } = createRuntime()
    sync(frame(1, { browserPageInventory: [entry('a')] }))
    sync(frame(2, { browserPageInventoryBaseVersion: 1 }))
    // Stored host-only preservation went stale, so the exact accepted revision is admitted again.
    vi.spyOn(
      internals as unknown as { storedMobileSnapshotHasStalePreservedTab: () => boolean },
      'storedMobileSnapshotHasStalePreservedTab'
    ).mockReturnValue(true)
    const before = stored()

    // A base equal to the frame's own version cannot be an older acknowledged publication.
    expect(
      sync(frame(2, { browserPageInventoryBaseVersion: 2 })).mobileSessionResyncWorktrees
    ).toEqual([WT])
    expect(stored()).toBe(before)
    // Without an accepted pair a further reference is a missing base, not a reuse.
    expect(
      sync(frame(3, { browserPageInventoryBaseVersion: 2 })).mobileSessionResyncWorktrees
    ).toEqual([WT])
    expect(stored()).toBe(before)

    expect(
      sync(frame(2, { browserPageInventory: [entry('a')] })).mobileSessionResyncWorktrees
    ).toBeUndefined()
    expect(stored()).not.toBe(before)
    expect(stored()!.browserPageInventory!.map((page) => page.browserPageId)).toEqual(['a'])
  })

  it('resyncs a base when the accepted publication carried no inventory and keeps legacy fallback', () => {
    const { sync, stored } = createRuntime()
    // An older renderer publishes no inventory and no base: listing keeps its selected-row fallback.
    sync(frame(1))
    expect(sync(frame(2)).mobileSessionResyncWorktrees).toBeUndefined()
    expect(stored()).not.toHaveProperty('browserPageInventory')

    expect(
      sync(frame(3, { browserPageInventoryBaseVersion: 2 })).mobileSessionResyncWorktrees
    ).toEqual([WT])
    expect(stored()!.tabs[0]).toMatchObject({ title: 'Terminal v2' })
  })

  it('skips a duplicate hinted frame after a lost acknowledgement without a resync', () => {
    const { sync, stored } = createRuntime()
    const inventory = [entry('a')]
    sync(frame(1, { browserPageInventory: inventory }))
    sync(frame(2, { browserPageInventoryBaseVersion: 1 }))
    const before = stored()

    expect(
      sync(frame(2, { browserPageInventoryBaseVersion: 1 })).mobileSessionResyncWorktrees
    ).toBeUndefined()
    expect(stored()).toBe(before)
    // The next frame names the version main did accept.
    sync(frame(3, { browserPageInventoryBaseVersion: 2 }))
    expect(stored()!.tabs[0]).toMatchObject({ title: 'Terminal v3' })
    expect(stored()!.browserPageInventory).toBe(inventory)
  })

  it('fences a removed occupant without a resync loop and makes its successor resend in full', () => {
    const { sync, stored, recreate, remove } = createRuntime()
    sync(frame(1, { browserPageInventory: [entry('a')] }))
    remove()
    recreate('occupant-2')

    const late = sync(frame(2, { browserPageInventoryBaseVersion: 1 }))
    expect(late.mobileSessionResyncWorktrees).toBeUndefined()
    expect(stored()).toBeUndefined()

    const successor = { worktreeInstanceId: 'occupant-2' }
    expect(
      sync(frame(3, { ...successor, browserPageInventoryBaseVersion: 1 }))
        .mobileSessionResyncWorktrees
    ).toEqual([WT])
    expect(stored()).toBeUndefined()
    sync(frame(3, { ...successor, browserPageInventory: [entry('b')] }))
    expect(stored()!.browserPageInventory!.map((page) => page.browserPageId)).toEqual(['b'])
  })

  it.each([
    [
      'an inventory beside a base',
      { browserPageInventory: [entry('a')], browserPageInventoryBaseVersion: 1 }
    ],
    ['a fractional base', { browserPageInventoryBaseVersion: 1.5 }],
    ['a string base', { browserPageInventoryBaseVersion: '1' as unknown as number }]
  ])('rejects %s before any state changes', (_label, malformed) => {
    const { sync, stored } = createRuntime()
    sync(frame(1, { browserPageInventory: [entry('a')] }))
    const before = stored()

    expect(() => sync(frame(2, malformed))).toThrow('invalid_browser_page_inventory')
    expect(stored()).toBe(before)
  })
})
