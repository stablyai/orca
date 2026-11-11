// @vitest-environment happy-dom
// Exercise the real desktop writer/UI slice and persistence merge with queued IPC broadcasts; model Expo mobile mapping locally. Disjoint edits must survive stale mirrors and converge (STA-5781).
import { StrictMode, act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import { getDefaultUIState } from '../../../shared/constants'
import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { getPersistedUI } from '../../../main/persistence/applying-settings/ui-state-read'
import {
  updatePersistedUI,
  type UIUpdateOperations
} from '../../../main/persistence/applying-settings/ui-state-update'
import type { AppState } from '../store/types'
import { createUIStore } from '../store/slices/ui/ui-slice-test-harness'
import {
  capturePersistedUIWriteBaseline,
  diffPersistedUIWriteFields
} from '../store/slices/ui/persisted-ui-write-baseline'
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

  it('the desktop debounced writer preserves a concurrent client’s field', async () => {
    // t=0: desktop toggles a desktop-only filter (disjoint from mobile fields).
    act(() => {
      store.getState().setHideCliCreatedWorkspaces(true)
    })

    // Apply mobile’s disjoint edit before the desktop debounce, but delay its broadcast.
    act(() => {
      vi.advanceTimersByTime(100)
    })
    authority.set({ hideSleepingWorkspaces: true })
    expect(authority.get().hideSleepingWorkspaces).toBe(true)

    // Flush the desktop’s still-stale mirror.
    await flushDesktopDebounce()

    expect(authority.get().hideCliCreatedWorkspaces).toBe(true)
    expect(authority.get().hideSleepingWorkspaces).toBe(true)

    deliverBroadcasts()
    expect(store.getState().showSleepingWorkspaces).toBe(false)
    expect(store.getState().hideCliCreatedWorkspaces).toBe(true)
  })

  it('a broadcast landing inside the debounce window must not revert the pending desktop toggle', async () => {
    // t=0: desktop toggles a filter; its write is pending in the 150ms debounce.
    act(() => {
      store.getState().setHideCliCreatedWorkspaces(true)
    })

    // t<150ms: another client changes a disjoint field AND its broadcast is delivered
    // before the desktop debounce fires. The broadcast still carries the OLD
    // value of the desktop's pending toggle.
    authority.set({ hideSleepingWorkspaces: true })
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
})
