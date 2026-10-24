// @vitest-environment happy-dom
// Exercise the real desktop writer/UI slice and persistence merge with queued IPC broadcasts; model Expo mobile mapping locally. Disjoint edits must survive stale mirrors and converge (STA-5781).
import { StrictMode, act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import { getDefaultUIState } from '../../../shared/constants'
import { omitPairingLocalUiFields } from '../../../shared/pairing-local-ui-fields'
import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { getPersistedUI } from '../../../main/persistence/applying-settings/ui-state-read'
import {
  updatePersistedUI,
  type UIUpdateOperations
} from '../../../main/persistence/applying-settings/ui-state-update'
import type { AppState } from '../store/types'
import { createUIStore } from '../store/slices/ui-slice-test-harness'
import {
  capturePersistedUIWriteBaseline,
  diffPersistedUIWriteFields
} from '../store/slices/persisted-ui-write-baseline'
import { usePersistedUIWriter } from './use-persisted-ui-writer'

const storeRef = vi.hoisted(() => ({
  current: null as unknown as StoreApi<unknown>
}))

vi.mock('../store', async () => {
  const { useStore } = await import('zustand')
  const useAppStore = (selector: (s: unknown) => unknown) => useStore(storeRef.current, selector)
  useAppStore.getState = () => storeRef.current.getState()
  useAppStore.setState = (partial: never) => storeRef.current.setState(partial)
  useAppStore.subscribe = (listener: never) => storeRef.current.subscribe(listener)
  return { useAppStore }
})

/** The main-process authority: the real ui.set merge over a real PersistedState. */
function createAuthority() {
  const state = { ui: { ...getDefaultUIState() } } as PersistedState
  let activeView: PersistedState['ui']['activeView'] = 'terminal'
  const listeners = new Set<(ui: PersistedUIState) => void>()
  const operations: UIUpdateOperations = {
    state,
    removeRetainedBlob: () => {},
    setActiveView: (next) => {
      if (next === undefined || next === activeView) {
        return false
      }
      activeView = next
      return true
    },
    getUI: () => getPersistedUI(state, activeView),
    scheduleSave: () => {},
    notifyUIChanged: () => {
      const ui = getPersistedUI(state, activeView)
      for (const listener of listeners) {
        listener(ui)
      }
    }
  }
  return {
    set: (updates: Partial<PersistedUIState>) => updatePersistedUI(operations, updates),
    get: () => getPersistedUI(state, activeView),
    onChanged: (listener: (ui: PersistedUIState) => void) => listeners.add(listener)
  }
}

type Authority = ReturnType<typeof createAuthority>

// Model the Expo mobile mapping locally because the desktop runner cannot transform its sources.
type MobileViewState = {
  groupMode: 'none' | 'workspaceStatus' | 'repo' | 'prStatus'
  sortMode: 'smart' | 'name' | 'recent' | 'repo' | 'manual'
  hideSleeping: boolean
  hideDefaultBranch: boolean
  alwaysShowDefaultBranch: boolean
  filterRepoIds: string[]
  collapsedGroups: string[]
}

/** Match shipping buildWorkspaceViewSettingsUpdate: send touched fields only. */
function patchOnlyUpdate(
  patch: Partial<MobileViewState>,
  next: MobileViewState
): Partial<PersistedUIState> {
  const update: Partial<PersistedUIState> = {}
  if ('groupMode' in patch) {
    update.groupBy = next.groupMode === 'workspaceStatus' ? 'workspace-status' : 'repo'
  }
  if ('sortMode' in patch) {
    update.sortBy = next.sortMode
  }
  if ('hideSleeping' in patch) {
    update.hideSleepingWorkspaces = next.hideSleeping
  }
  if ('hideDefaultBranch' in patch) {
    update.hideDefaultBranchWorkspace = next.hideDefaultBranch
  }
  if ('filterRepoIds' in patch) {
    update.filterRepoIds = next.filterRepoIds
  }
  if ('collapsedGroups' in patch) {
    update.collapsedGroups = next.collapsedGroups
  }
  return update
}

/** Model of the mobile host screen's view-settings client (persistViewSettings et al.). */
function createMobileClient(authority: Authority) {
  let view: MobileViewState = {
    groupMode: 'repo',
    sortMode: 'recent',
    hideSleeping: false,
    hideDefaultBranch: false,
    alwaysShowDefaultBranch: true,
    filterRepoIds: [],
    collapsedGroups: []
  }
  return {
    get view() {
      return view
    },
    /** Merge shared ui.get state per field, matching applyDesktopViewSettings. */
    sync() {
      const ui = omitPairingLocalUiFields(authority.get())
      view = {
        ...view,
        hideSleeping: ui.hideSleepingWorkspaces ?? view.hideSleeping,
        hideDefaultBranch: ui.hideDefaultBranchWorkspace ?? view.hideDefaultBranch,
        alwaysShowDefaultBranch:
          ui.alwaysShowDefaultBranchWorkspace ?? view.alwaysShowDefaultBranch,
        filterRepoIds: ui.filterRepoIds ?? view.filterRepoIds,
        collapsedGroups: ui.collapsedGroups ?? view.collapsedGroups
      }
    },
    /** A user tap: apply locally, then push through the shipping payload shape. */
    tap(patch: Partial<MobileViewState>) {
      view = { ...view, ...patch }
      const payload = patchOnlyUpdate(patch, view)
      authority.set(omitPairingLocalUiFields(payload) as Partial<PersistedUIState>)
    }
  }
}

describe('workspace view preferences: cross-client persistence (STA-5781)', () => {
  let authority: Authority
  let store: StoreApi<AppState>
  let root: Root
  let container: HTMLDivElement
  let pendingBroadcasts: PersistedUIState[]
  let holdAcks: boolean
  let rejectSets: boolean
  let rejectNextSet: boolean
  let setCallCount: number
  let pendingAcks: (() => void)[]
  let pendingRejects: ((reason?: unknown) => void)[]

  async function resolveAcks() {
    await act(async () => {
      for (const resolve of pendingAcks.splice(0)) {
        resolve()
      }
      await Promise.resolve()
    })
  }

  function deliverBroadcasts() {
    const queued = pendingBroadcasts.splice(0)
    for (const ui of queued) {
      act(() => {
        store.getState().hydratePersistedUI(ui, 'sync')
      })
    }
  }

  function mountDesktopWriter() {
    function Probe() {
      usePersistedUIWriter()
      return null
    }
    // Match real StrictMode mount/cleanup replay.
    act(() => {
      root.render(createElement(StrictMode, null, createElement(Probe)))
    })
  }

  async function flushDesktopDebounce() {
    // Drain the ack microtask so the writer folds its baseline before assertions.
    await act(async () => {
      vi.advanceTimersByTime(200)
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    authority = createAuthority()
    pendingBroadcasts = []
    authority.onChanged((ui) => pendingBroadcasts.push(ui))
    store = createUIStore()
    storeRef.current = store as unknown as typeof storeRef.current
    holdAcks = false
    rejectSets = false
    rejectNextSet = false
    setCallCount = 0
    pendingAcks = []
    pendingRejects = []
    ;(window as unknown as { api: unknown }).api = {
      ui: {
        set: (updates: Partial<PersistedUIState>) => {
          setCallCount += 1
          // rejectSets models transport failure: nothing reaches the host.
          if (rejectSets) {
            return Promise.reject(new Error('transport failure'))
          }
          if (rejectNextSet) {
            rejectNextSet = false
            return new Promise<void>((_, reject) => pendingRejects.push(reject))
          }
          // Apply before resolving as IPC does; held acks expose the in-flight window.
          authority.set(updates)
          if (!holdAcks) {
            return Promise.resolve()
          }
          return new Promise<void>((resolve) => pendingAcks.push(resolve))
        }
      }
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      store.getState().hydratePersistedUI(authority.get(), 'startup')
    })
    mountDesktopWriter()
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.useRealTimers()
  })

  it('desktop restart alone does not rewrite the authority (control)', async () => {
    const before = authority.get()
    await flushDesktopDebounce()
    const after = authority.get()
    expect(after.hideSleepingWorkspaces).toBe(before.hideSleepingWorkspaces)
    expect(after.hideDefaultBranchWorkspace).toBe(before.hideDefaultBranchWorkspace)
    expect(after.hideCliCreatedWorkspaces).toBe(before.hideCliCreatedWorkspaces)
  })

  it('saves a revealed remote host after an unrelated older broadcast', async () => {
    act(() => {
      authority.set({ workspaceHostScope: 'local', visibleWorkspaceHostIds: ['local'] })
    })
    deliverBroadcasts()
    act(() => {
      authority.set({ sidebarWidth: 320 })
      store.getState().setVisibleWorkspaceHostIds(['local', 'runtime:m4air'])
    })
    pendingBroadcasts.reverse()
    deliverBroadcasts()
    expect(store.getState().visibleWorkspaceHostIds).toEqual(['local', 'runtime:m4air'])
    await flushDesktopDebounce()
    deliverBroadcasts()
    expect(authority.get().visibleWorkspaceHostIds).toEqual(['local', 'runtime:m4air'])
    expect(authority.get().sidebarWidth).toBe(320)
  })

  it('saves All hosts after flipping back during a host-selection write', async () => {
    holdAcks = true
    act(() => store.getState().setWorkspaceHostScope('local'))
    await flushDesktopDebounce()
    act(() => store.getState().setWorkspaceHostScope('all'))
    deliverBroadcasts()
    expect(store.getState().visibleWorkspaceHostIds).toBeNull()
    expect(store.getState().workspaceHostScope).toBe('all')
    await resolveAcks()
    holdAcks = false
    await flushDesktopDebounce()
    deliverBroadcasts()
    expect(authority.get().visibleWorkspaceHostIds).toBeNull()
    expect(authority.get().workspaceHostScope).toBe('all')
  })

  it('persists a left sidebar close across an unrelated sync and restores it on startup', async () => {
    act(() => {
      store.getState().toggleSidebar()
      authority.set({ sidebarWidth: 320 })
    })
    deliverBroadcasts()
    expect(store.getState().sidebarOpen).toBe(false)
    await flushDesktopDebounce()
    expect(authority.get().sidebarOpen).toBe(false)

    const restarted = createUIStore()
    restarted.getState().hydratePersistedUI(authority.get(), 'startup')
    expect(restarted.getState().sidebarOpen).toBe(false)
    expect(restarted.getState().sidebarWidth).toBe(320)
  })

  it('persists a left sidebar reopen while the close acknowledgement is still pending', async () => {
    holdAcks = true
    act(() => store.getState().toggleSidebar())
    await flushDesktopDebounce()
    expect(authority.get().sidebarOpen).toBe(false)

    act(() => store.getState().toggleSidebar())
    deliverBroadcasts()
    expect(store.getState().sidebarOpen).toBe(true)
    await resolveAcks()
    await flushDesktopDebounce()
    await resolveAcks()
    deliverBroadcasts()
    expect(authority.get().sidebarOpen).toBe(true)
    expect(store.getState().sidebarOpen).toBe(true)
    expect(store.getState().persistedUIWriteInFlightCounts).toEqual({})
  })

  it('a mobile tap must not revert a desktop change the mobile mirror has not seen', async () => {
    const mobile = createMobileClient(authority)
    mobile.sync()

    act(() => {
      store.getState().setHideDefaultBranchWorkspace(true)
    })
    await flushDesktopDebounce()
    expect(authority.get().hideDefaultBranchWorkspace).toBe(true)
    deliverBroadcasts()

    // The mobile mirror is still stale while it edits a disjoint field.
    mobile.tap({ hideSleeping: true })

    expect(authority.get().hideSleepingWorkspaces).toBe(true)
    expect(authority.get().hideDefaultBranchWorkspace).toBe(true)

    deliverBroadcasts()
    expect(store.getState().hideDefaultBranchWorkspace).toBe(true)
  })

  it('persists the desktop sleeping-workspaces toggle in the durable hide form', async () => {
    // Verify mirror-to-wire inversion: showSleeping=false persists hideSleeping=true.
    act(() => {
      store.getState().setShowSleepingWorkspaces(false)
    })
    await flushDesktopDebounce()
    expect(authority.get().hideSleepingWorkspaces).toBe(true)

    act(() => {
      store.getState().setShowSleepingWorkspaces(true)
    })
    await flushDesktopDebounce()
    expect(authority.get().hideSleepingWorkspaces).toBe(false)
  })

  it('the desktop debounced writer must not revert a concurrent mobile change', async () => {
    const mobile = createMobileClient(authority)
    mobile.sync()

    act(() => {
      store.getState().setHideCliCreatedWorkspaces(true)
    })

    // Apply mobile’s disjoint edit before the desktop debounce, but delay its broadcast.
    act(() => {
      vi.advanceTimersByTime(100)
    })
    mobile.tap({ hideSleeping: true })
    expect(authority.get().hideSleepingWorkspaces).toBe(true)

    // Flush the desktop’s still-stale mirror.
    await flushDesktopDebounce()

    expect(authority.get().hideCliCreatedWorkspaces).toBe(true)
    expect(authority.get().hideSleepingWorkspaces).toBe(true)

    deliverBroadcasts()
    mobile.sync()
    expect(store.getState().showSleepingWorkspaces).toBe(false)
    expect(store.getState().hideCliCreatedWorkspaces).toBe(true)
    expect(mobile.view.hideSleeping).toBe(true)
  })

  it('a broadcast landing inside the debounce window must not revert the pending desktop toggle', async () => {
    const mobile = createMobileClient(authority)
    mobile.sync()

    act(() => {
      store.getState().setHideCliCreatedWorkspaces(true)
    })

    // Deliver mobile’s disjoint edit before debounce; its broadcast still contains the old desktop field.
    mobile.tap({ hideSleeping: true })
    deliverBroadcasts()

    expect(store.getState().hideCliCreatedWorkspaces).toBe(true)
    expect(store.getState().showSleepingWorkspaces).toBe(false)

    await flushDesktopDebounce()

    expect(authority.get().hideCliCreatedWorkspaces).toBe(true)
    expect(authority.get().hideSleepingWorkspaces).toBe(true)
  })

  it('preserves a flip-back made while the first write is still in flight', async () => {
    // A flip-back matches the pre-ack baseline. Track in-flight fields so an obsolete ack/echo cannot erase the second toggle (PR #17057).
    holdAcks = true
    act(() => {
      store.getState().setHideDefaultBranchWorkspace(true)
    })
    await flushDesktopDebounce()
    expect(authority.get().hideDefaultBranchWorkspace).toBe(true)

    act(() => {
      store.getState().setHideDefaultBranchWorkspace(false)
    })
    // Deliver the first write’s echo before its ack.
    deliverBroadcasts()
    expect(store.getState().hideDefaultBranchWorkspace).toBe(false)

    await resolveAcks()
    await flushDesktopDebounce()
    await resolveAcks()
    expect(authority.get().hideDefaultBranchWorkspace).toBe(false)
    deliverBroadcasts()
    expect(store.getState().hideDefaultBranchWorkspace).toBe(false)
  })

  it('edits made during the ack window flush at debounce rate, not ack rate', async () => {
    // Trailing rediffs must obey debounce, or dragging sends one write per IPC ack.
    holdAcks = true
    act(() => {
      store.getState().setHideDefaultBranchWorkspace(true)
    })
    await flushDesktopDebounce()
    const sendsAfterFirstFlush = setCallCount

    act(() => {
      store.getState().setHideCliCreatedWorkspaces(true)
    })
    act(() => {
      store.getState().setHideDetachedHeadWorkspaces(true)
    })
    act(() => {
      store.getState().setHideAutomationGeneratedWorkspaces(true)
    })

    await resolveAcks()
    expect(setCallCount).toBe(sendsAfterFirstFlush)

    await flushDesktopDebounce()
    expect(setCallCount).toBe(sendsAfterFirstFlush + 1)
    await resolveAcks()
    await flushDesktopDebounce()
    await resolveAcks()
    expect(authority.get().hideDefaultBranchWorkspace).toBe(true)
    expect(authority.get().hideCliCreatedWorkspaces).toBe(true)
    expect(authority.get().hideDetachedHeadWorkspaces).toBe(true)
    expect(authority.get().hideAutomationGeneratedWorkspaces).toBe(true)
  })

  it('converges when a remote client writes the same field during the ack window', async () => {
    // Never fold an ack over a newer hydrated baseline; it would leave mirror/authority divergent without further traffic.
    holdAcks = true
    const mobile = createMobileClient(authority)
    mobile.sync()

    act(() => {
      store.getState().setHideDefaultBranchWorkspace(true)
    })
    await flushDesktopDebounce()

    // A later mobile write to the same field and both broadcasts precede the desktop ack.
    mobile.tap({ hideDefaultBranch: false })
    deliverBroadcasts()
    await resolveAcks()

    await flushDesktopDebounce()
    await resolveAcks()
    deliverBroadcasts()
    await flushDesktopDebounce()
    await resolveAcks()
    deliverBroadcasts()

    // Same-field conflicts may choose either writer, but settled mirrors must agree.
    expect(store.getState().hideDefaultBranchWorkspace).toBe(
      authority.get().hideDefaultBranchWorkspace
    )
  })

  it('a rejected write folds nothing and re-flushes with the next change', async () => {
    rejectSets = true
    act(() => {
      store.getState().setHideDefaultBranchWorkspace(true)
    })
    await flushDesktopDebounce()
    expect(authority.get().hideDefaultBranchWorkspace).toBe(false)
    expect(store.getState().persistedUIWriteInFlightCounts).toEqual({})

    rejectSets = false
    act(() => {
      store.getState().setHideCliCreatedWorkspaces(true)
    })
    await flushDesktopDebounce()
    await flushDesktopDebounce()
    expect(authority.get().hideDefaultBranchWorkspace).toBe(true)
    expect(authority.get().hideCliCreatedWorkspaces).toBe(true)
  })

  it('a terminal rejection leaves one dirty field without an automatic retry loop', async () => {
    // Keep rejection dirty for a later edit without scheduling an endless trailing retry loop.
    rejectSets = true
    setCallCount = 0
    act(() => {
      store.getState().setHideDefaultBranchWorkspace(true)
    })

    vi.advanceTimersByTime(150)
    // Settle rejection without firing any erroneously rearmed timer yet.
    await Promise.resolve()

    // Assert transport count, settled markers and no retry timer independently; the field stays dirty.
    expect(setCallCount).toBe(1)
    expect(store.getState().persistedUIWriteInFlightCounts).toEqual({})
    const state = store.getState()
    expect(
      diffPersistedUIWriteFields(
        capturePersistedUIWriteBaseline(state),
        state.persistedUIWriteBaseline!
      )
    ).toEqual({ hideDefaultBranchWorkspace: true })
    expect(vi.getTimerCount()).toBe(0)

    // A new edit explicitly flushes both its change and the previous dirty field.
    rejectSets = false
    act(() => {
      store.getState().setHideCliCreatedWorkspaces(true)
    })
    vi.advanceTimersByTime(150)
    await Promise.resolve()
    expect(setCallCount).toBe(2)
    expect(authority.get().hideDefaultBranchWorkspace).toBe(true)
    expect(authority.get().hideCliCreatedWorkspaces).toBe(true)
    expect(store.getState().persistedUIWriteInFlightCounts).toEqual({})

    // Unmount must cancel delayed work and prevent later store writes.
    act(() => {
      root.unmount()
    })
    expect(vi.getTimerCount()).toBe(0)
    store.getState().setHideDetachedHeadWorkspaces(true)
    vi.advanceTimersByTime(300)
    expect(setCallCount).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a transient rejection still flushes a pending flip-back exactly once', async () => {
    // A newer pending edit still deserves one trailing flush after rejection; rejection alone does not.
    holdAcks = true
    rejectNextSet = true
    setCallCount = 0
    act(() => {
      store.getState().setHideDefaultBranchWorkspace(true)
    })
    vi.advanceTimersByTime(150)
    expect(setCallCount).toBe(1)
    expect(pendingRejects).toHaveLength(1)

    // Flip back and edit another field in flight; only newer edits authorize the trailing pass.
    act(() => {
      store.getState().setHideDefaultBranchWorkspace(false)
      store.getState().setHideCliCreatedWorkspaces(true)
    })
    holdAcks = false
    pendingRejects.splice(0).forEach((reject) => reject(new Error('transient transport failure')))
    expect(pendingRejects).toHaveLength(0)
    await Promise.resolve()
    vi.advanceTimersByTime(150)
    await Promise.resolve()

    expect(setCallCount).toBe(2)
    expect(authority.get().hideDefaultBranchWorkspace).toBe(false)
    expect(authority.get().hideCliCreatedWorkspaces).toBe(true)
    expect(store.getState().persistedUIWriteInFlightCounts).toEqual({})

    vi.advanceTimersByTime(150)
    await Promise.resolve()
    expect(setCallCount).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a rejected trailing write does not inherit automatic retry permission', async () => {
    // A trailing attempt rejected without newer edits is terminal too.
    holdAcks = true
    setCallCount = 0
    act(() => {
      store.getState().setHideDefaultBranchWorkspace(true)
    })
    vi.advanceTimersByTime(150)
    expect(setCallCount).toBe(1)

    act(() => {
      store.getState().setHideCliCreatedWorkspaces(true)
    })
    await resolveAcks()
    holdAcks = false
    rejectSets = true

    // Overlapping debounce/ack scheduling must yield only one rejected trailing attempt.
    vi.advanceTimersByTime(150)
    await Promise.resolve()
    expect(setCallCount).toBe(2)
    expect(store.getState().persistedUIWriteInFlightCounts).toEqual({})

    vi.advanceTimersByTime(150)
    await Promise.resolve()
    expect(setCallCount).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a synchronously throwing ui.set settles without a retry loop', async () => {
    const api = (
      window as unknown as { api: { ui: { set: (u: Partial<PersistedUIState>) => Promise<void> } } }
    ).api.ui
    const workingSet = api.set
    api.set = () => {
      setCallCount += 1
      throw new Error('non-cloneable argument')
    }
    act(() => {
      store.getState().setHideDefaultBranchWorkspace(true)
    })
    await flushDesktopDebounce()
    // A leaked marker would pin the field against hydration for the renderer's life.
    expect(store.getState().persistedUIWriteInFlightCounts).toEqual({})

    // Recovery is explicit: a later edit flushes the still-dirty field.
    api.set = workingSet
    act(() => {
      store.getState().setHideCliCreatedWorkspaces(true)
    })
    await flushDesktopDebounce()
    expect(authority.get().hideDefaultBranchWorkspace).toBe(true)
  })

  it('overlapping in-flight writes on one field decrement, not clear, the marker', () => {
    // Two overlapping writes require counts: the first ack must not unpin the second.
    const s = store.getState()
    s.notePersistedUIWriteStarted(['hideDefaultBranchWorkspace'])
    s.notePersistedUIWriteStarted(['hideDefaultBranchWorkspace'])
    store.getState().notePersistedUIWriteSettled(['hideDefaultBranchWorkspace'], null)
    expect(store.getState().persistedUIWriteInFlightCounts).toEqual({
      hideDefaultBranchWorkspace: 1
    })
    store.getState().notePersistedUIWriteSettled(['hideDefaultBranchWorkspace'], null)
    expect(store.getState().persistedUIWriteInFlightCounts).toEqual({})
  })

  it('desktop and mobile changing the same field converges on the newest write', async () => {
    const mobile = createMobileClient(authority)
    mobile.sync()

    act(() => {
      store.getState().setHideDefaultBranchWorkspace(true)
    })
    await flushDesktopDebounce()
    deliverBroadcasts()

    mobile.tap({ hideDefaultBranch: false })
    deliverBroadcasts()
    expect(authority.get().hideDefaultBranchWorkspace).toBe(false)
    await flushDesktopDebounce()
    expect(authority.get().hideDefaultBranchWorkspace).toBe(false)
    expect(store.getState().hideDefaultBranchWorkspace).toBe(false)
  })
})
