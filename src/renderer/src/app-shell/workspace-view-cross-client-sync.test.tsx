// @vitest-environment happy-dom
// STA-5781: workspace sidebar filter settings intermittently reset across clients.
//
// Topology under test (all shipping code except where pinned):
//   desktop renderer  = real usePersistedUIWriter + real UI slice (createUIStore)
//   authority (main)  = real updatePersistedUI/getPersistedUI merge
//   broadcast         = controlled queue modeling the async ui:stateChanged IPC send
//   mobile client     = mobile/src/worktree/workspace-view-settings mapping; the ui.set
//                       payload uses the shipping buildWorkspaceViewSettingsUpdate when
//                       exported, else the legacy whole-snapshot shape — the source-pin
//                       test asserts index.tsx matches whichever path is active, so the
//                       model stays tethered to shipping code on baseline and candidate.
//
// Invariant: when two independently identified clients change DISJOINT workspace-view
// fields concurrently or across stale-mirror windows, both changes survive and all
// mirrors converge; no client may restore a stale sibling field.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

// Local model of mobile/src/worktree/workspace-view-settings.ts (the desktop test
// runner cannot transform Expo-configured sources). The source-pin test at the
// bottom fails if the shipping module stops matching this model.
type MobileViewState = {
  groupMode: 'none' | 'workspaceStatus' | 'repo' | 'prStatus'
  sortMode: 'smart' | 'name' | 'recent' | 'repo' | 'manual'
  hideSleeping: boolean
  hideDefaultBranch: boolean
  alwaysShowDefaultBranch: boolean
  filterRepoIds: string[]
  collapsedGroups: string[]
}

function mobileHasPatchOnlyBuilder(): boolean {
  return readMobileViewSettingsSource().includes('export function buildWorkspaceViewSettingsUpdate')
}

/** Mirrors buildWorkspaceViewSettingsUpdate (candidate) — only touched fields. */
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

/** Mirrors the pre-fix persistViewSettings payload — the full snapshot on every tap. */
function legacyWholeSnapshotUpdate(next: MobileViewState): Partial<PersistedUIState> {
  return {
    groupBy: next.groupMode === 'workspaceStatus' ? 'workspace-status' : 'repo',
    sortBy: next.sortMode,
    hideSleepingWorkspaces: next.hideSleeping,
    hideDefaultBranchWorkspace: next.hideDefaultBranch,
    filterRepoIds: next.filterRepoIds,
    collapsedGroups: next.collapsedGroups
  }
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
    /** ui.get on connect/focus: merge the shared state onto the local mirror
     *  (mirrors applyDesktopViewSettings' ??-per-field semantics). */
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
      const payload = mobileHasPatchOnlyBuilder()
        ? patchOnlyUpdate(patch, view)
        : legacyWholeSnapshotUpdate(view)
      authority.set(omitPairingLocalUiFields(payload) as Partial<PersistedUIState>)
    }
  }
}

function readMobileHostScreenSource(): string {
  return readFileSync(join(__dirname, '../../../../mobile/app/h/[hostId]/index.tsx'), 'utf-8')
}

function readMobileViewSettingsSource(): string {
  return readFileSync(
    join(__dirname, '../../../../mobile/src/worktree/workspace-view-settings.ts'),
    'utf-8'
  )
}

describe('workspace view preferences: cross-client persistence (STA-5781)', () => {
  let authority: Authority
  let store: StoreApi<AppState>
  let root: Root
  let container: HTMLDivElement
  let pendingBroadcasts: PersistedUIState[]
  let holdAcks: boolean
  let rejectSets: boolean
  let setCallCount: number
  let pendingAcks: (() => void)[]

  async function resolveAcks() {
    await act(async () => {
      for (const resolve of pendingAcks.splice(0)) {
        resolve()
      }
      await Promise.resolve()
    })
  }

  function deliverBroadcasts() {
    // Models the async ui:stateChanged IPC delivery to the desktop renderer.
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
    // StrictMode, like the real renderer (main.tsx): the writer effect must
    // stay correct under double-invoked mount/cleanup cycles.
    act(() => {
      root.render(createElement(StrictMode, null, createElement(Probe)))
    })
  }

  async function flushDesktopDebounce() {
    // Async act: the writer folds its baseline in a .then after the ui.set
    // resolves, so the microtask queue must drain for the flush to register.
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
    setCallCount = 0
    pendingAcks = []
    ;(window as unknown as { api: unknown }).api = {
      ui: {
        set: (updates: Partial<PersistedUIState>) => {
          setCallCount += 1
          // rejectSets models transport failure: nothing reaches the host.
          if (rejectSets) {
            return Promise.reject(new Error('transport failure'))
          }
          // Like the real IPC: main applies the update before the renderer's
          // promise resolves; holdAcks models the in-flight round-trip window.
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
    // Startup: desktop hydrates from the authority before the writer arms.
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

  it('a mobile tap must not revert a desktop change the mobile mirror has not seen', async () => {
    const mobile = createMobileClient(authority)
    mobile.sync()

    // Desktop turns on "hide default branch"; the write lands and broadcasts.
    act(() => {
      store.getState().setHideDefaultBranchWorkspace(true)
    })
    await flushDesktopDebounce()
    expect(authority.get().hideDefaultBranchWorkspace).toBe(true)
    deliverBroadcasts()

    // Mobile (mirror stale since its last ui.get) toggles the DISJOINT
    // "hide sleeping" filter.
    mobile.tap({ hideSleeping: true })

    // Both changes must survive.
    expect(authority.get().hideSleepingWorkspaces).toBe(true)
    expect(authority.get().hideDefaultBranchWorkspace).toBe(true)

    // And the desktop mirror must not be reverted by the echoed broadcast.
    deliverBroadcasts()
    expect(store.getState().hideDefaultBranchWorkspace).toBe(true)
  })

  it('persists the desktop sleeping-workspaces toggle in the durable hide form', async () => {
    // Pins the mirror->wire inversion end-to-end: showSleepingWorkspaces false
    // must land as hideSleepingWorkspaces true at the authority.
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

    // t=0: desktop toggles a desktop-only filter (disjoint from mobile fields).
    act(() => {
      store.getState().setHideCliCreatedWorkspaces(true)
    })

    // t<150ms: mobile turns on "hide sleeping". The authority applies it, but the
    // ui:stateChanged broadcast is still in flight to the desktop renderer.
    act(() => {
      vi.advanceTimersByTime(100)
    })
    mobile.tap({ hideSleeping: true })
    expect(authority.get().hideSleepingWorkspaces).toBe(true)

    // t=150ms: the desktop debounce fires from its (not yet re-hydrated) mirror.
    await flushDesktopDebounce()

    // Both disjoint changes must survive.
    expect(authority.get().hideCliCreatedWorkspaces).toBe(true)
    expect(authority.get().hideSleepingWorkspaces).toBe(true)

    // After full delivery and a mobile re-sync, every mirror converges on both.
    deliverBroadcasts()
    mobile.sync()
    expect(store.getState().showSleepingWorkspaces).toBe(false)
    expect(store.getState().hideCliCreatedWorkspaces).toBe(true)
    expect(mobile.view.hideSleeping).toBe(true)
  })

  it('a broadcast landing inside the debounce window must not revert the pending desktop toggle', async () => {
    const mobile = createMobileClient(authority)
    mobile.sync()

    // t=0: desktop toggles a filter; its write is pending in the 150ms debounce.
    act(() => {
      store.getState().setHideCliCreatedWorkspaces(true)
    })

    // t<150ms: mobile changes a disjoint field AND its broadcast is delivered
    // before the desktop debounce fires. The broadcast still carries the OLD
    // value of the desktop's pending toggle.
    mobile.tap({ hideSleeping: true })
    deliverBroadcasts()

    // The hydration must not wipe the user's pending toggle from the mirror.
    expect(store.getState().hideCliCreatedWorkspaces).toBe(true)
    // The remote change must land in the mirror.
    expect(store.getState().showSleepingWorkspaces).toBe(false)

    await flushDesktopDebounce()

    // Both disjoint changes survive at the authority.
    expect(authority.get().hideCliCreatedWorkspaces).toBe(true)
    expect(authority.get().hideSleepingWorkspaces).toBe(true)
  })

  it('preserves a flip-back made while the first write is still in flight', async () => {
    // CodeRabbit PR#17057 finding: toggle -> debounce fires (write in flight)
    // -> toggle back. The flip-back equals the pre-fold baseline, so without
    // in-flight tracking it diffs empty, the ack folds the obsolete value in,
    // and the echo broadcast visually reverts the user's second toggle.
    holdAcks = true
    act(() => {
      store.getState().setHideDefaultBranchWorkspace(true)
    })
    await flushDesktopDebounce()
    expect(authority.get().hideDefaultBranchWorkspace).toBe(true)

    // Flip back while the first write's ack is still in flight.
    act(() => {
      store.getState().setHideDefaultBranchWorkspace(false)
    })
    // The echo of the FIRST write arrives before the ack.
    deliverBroadcasts()
    expect(store.getState().hideDefaultBranchWorkspace).toBe(false)

    // Ack lands; the writer must notice the mirror moved on and re-flush.
    await resolveAcks()
    await flushDesktopDebounce()
    await resolveAcks()
    expect(authority.get().hideDefaultBranchWorkspace).toBe(false)
    deliverBroadcasts()
    expect(store.getState().hideDefaultBranchWorkspace).toBe(false)
  })

  it('edits made during the ack window flush at debounce rate, not ack rate', async () => {
    // Round-3 review: the trailing re-diff must not bypass the 150ms debounce,
    // or one in-flight write turns a drag into one ui.set per IPC round trip.
    holdAcks = true
    act(() => {
      store.getState().setHideDefaultBranchWorkspace(true)
    })
    await flushDesktopDebounce()
    const sendsAfterFirstFlush = setCallCount

    // Rapid edits while the first write's ack is in flight.
    act(() => {
      store.getState().setHideCliCreatedWorkspaces(true)
    })
    act(() => {
      store.getState().setHideDetachedHeadWorkspaces(true)
    })
    act(() => {
      store.getState().setHideAutomationGeneratedWorkspaces(true)
    })

    // The ack lands: nothing may be sent inline — only a debounced flush later.
    await resolveAcks()
    expect(setCallCount).toBe(sendsAfterFirstFlush)

    // One debounce window later, the three edits coalesce into a single write.
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
    // Round-3 review: the ack must not fold the sent value over a baseline a
    // hydration advanced past, or the mirror and authority diverge with no
    // further traffic to reconcile them (the reset then reappears later).
    holdAcks = true
    const mobile = createMobileClient(authority)
    mobile.sync()

    act(() => {
      store.getState().setHideDefaultBranchWorkspace(true)
    })
    await flushDesktopDebounce()

    // Mobile writes the SAME field at the authority after us; both broadcasts
    // (our echo, then mobile's) land before our ack does.
    mobile.tap({ hideDefaultBranch: false })
    deliverBroadcasts()
    await resolveAcks()

    await flushDesktopDebounce()
    await resolveAcks()
    deliverBroadcasts()
    await flushDesktopDebounce()
    await resolveAcks()
    deliverBroadcasts()

    // Either side may win a same-field conflict, but mirror and authority
    // must agree once traffic settles.
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
    // The rejection must settle the in-flight marker, not leak it.
    expect(store.getState().persistedUIWriteInFlightCounts).toEqual({})

    // Transport recovers; the next edit re-flushes the dirty field too.
    rejectSets = false
    act(() => {
      store.getState().setHideCliCreatedWorkspaces(true)
    })
    await flushDesktopDebounce()
    await flushDesktopDebounce()
    expect(authority.get().hideDefaultBranchWorkspace).toBe(true)
    expect(authority.get().hideCliCreatedWorkspaces).toBe(true)
  })

  it('a synchronously throwing ui.set still settles the marker and reschedules', async () => {
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

    // The throw must also reschedule the trailing pass: once the transport
    // recovers, the dirty field flushes without waiting for another edit.
    api.set = workingSet
    await flushDesktopDebounce()
    expect(authority.get().hideDefaultBranchWorkspace).toBe(true)
  })

  it('a rejection re-schedules the trailing pass it caused to be skipped', async () => {
    // Round-3 verification: a trailing pass that bails because a write is in
    // flight relies on that write's settle to reschedule — including rejection,
    // or a pending flip-back is stranded until the next unrelated edit.
    holdAcks = true
    act(() => {
      store.getState().setHideDefaultBranchWorkspace(true)
    })
    await flushDesktopDebounce()
    // Flip back while write #1 is in flight: only a trailing flush carries it.
    act(() => {
      store.getState().setHideDefaultBranchWorkspace(false)
    })
    await resolveAcks()

    // Before the trailing pass fires, a different field's write goes out and
    // is REJECTED while in flight when the trailing pass checks.
    rejectSets = true
    act(() => {
      store.getState().setHideCliCreatedWorkspaces(true)
    })
    await flushDesktopDebounce()

    rejectSets = false
    holdAcks = false
    await flushDesktopDebounce()
    await flushDesktopDebounce()
    expect(authority.get().hideDefaultBranchWorkspace).toBe(false)
    expect(store.getState().hideDefaultBranchWorkspace).toBe(false)
  })

  it('overlapping in-flight writes on one field decrement, not clear, the marker', () => {
    // Unit-pins the count semantics: ack #1 of two overlapping writes must not
    // un-pin the field while write #2 is still out.
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

    // Mobile flips the SAME field afterwards; last writer wins everywhere.
    mobile.tap({ hideDefaultBranch: false })
    deliverBroadcasts()
    expect(authority.get().hideDefaultBranchWorkspace).toBe(false)
    await flushDesktopDebounce()
    expect(authority.get().hideDefaultBranchWorkspace).toBe(false)
    expect(store.getState().hideDefaultBranchWorkspace).toBe(false)
  })

  it('pins the modeled mobile ui.set payload to the shipping source', async () => {
    const source = readMobileHostScreenSource()
    if (mobileHasPatchOnlyBuilder()) {
      // Candidate: index.tsx must push through the patch-only builder this model uses.
      expect(source).toContain('buildWorkspaceViewSettingsUpdate(patch, next)')
      const builderSource = readMobileViewSettingsSource()
      for (const guard of [
        "if ('groupMode' in patch)",
        "if ('sortMode' in patch)",
        "if ('hideSleeping' in patch)",
        "if ('hideDefaultBranch' in patch)",
        "if ('filterRepoIds' in patch)",
        "if ('collapsedGroups' in patch)"
      ]) {
        expect(builderSource).toContain(guard)
      }
    } else {
      // Baseline: persistViewSettings pushes exactly this whole-snapshot payload.
      for (const key of [
        'groupBy: groupModeToDesktop(next.groupMode)',
        'sortBy: next.sortMode',
        'hideSleepingWorkspaces: next.hideSleeping',
        'hideDefaultBranchWorkspace: next.hideDefaultBranch',
        'filterRepoIds: next.filterRepoIds',
        'collapsedGroups: next.collapsedGroups'
      ]) {
        expect(source).toContain(key)
      }
    }
  })
})
