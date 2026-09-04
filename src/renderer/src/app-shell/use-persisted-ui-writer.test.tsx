// @vitest-environment happy-dom
// A new web client against a host whose strict `ui.set` schema predates the session grid
// keys: the rejection must quarantine those keys instead of re-diffing them into every
// later patch, or nothing this writer owns ever persists to that host again.
import { StrictMode, act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import { getDefaultUIState } from '../../../shared/constants'
import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
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

const OLD_HOST_KNOWN_KEYS = new Set(
  Object.keys(getDefaultUIState()).filter((key) => !key.startsWith('sessionsGrid'))
)

/** Models an old host's strict UiUpdate: any unknown key rejects the whole batch. */
function createOldHost() {
  const ui: Partial<PersistedUIState> = {}
  const sets: Partial<PersistedUIState>[] = []
  return {
    ui,
    sets,
    set: (updates: Partial<PersistedUIState>) => {
      sets.push(updates)
      const unknown = Object.keys(updates).filter((key) => !OLD_HOST_KNOWN_KEYS.has(key))
      if (unknown.length > 0) {
        const quoted = unknown.map((key) => `"${key}"`).join(', ')
        return Promise.reject(
          Object.assign(new Error(`Unrecognized key${unknown.length > 1 ? 's' : ''}: ${quoted}`), {
            code: 'invalid_argument'
          })
        )
      }
      Object.assign(ui, updates)
      return Promise.resolve()
    }
  }
}

describe('usePersistedUIWriter against a host that rejects unknown keys', () => {
  let host: ReturnType<typeof createOldHost>
  let store: StoreApi<AppState>
  let root: Root
  let container: HTMLDivElement

  async function flush() {
    await act(async () => {
      vi.advanceTimersByTime(200)
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  function dirtyFields(): string[] {
    const state = store.getState()
    return Object.keys(
      diffPersistedUIWriteFields(
        capturePersistedUIWriteBaseline(state),
        state.persistedUIWriteBaseline!
      )
    )
  }

  beforeEach(() => {
    vi.useFakeTimers()
    host = createOldHost()
    store = createUIStore()
    storeRef.current = store as unknown as typeof storeRef.current
    // Hydration's own migration writes ride the fire-and-forget set; the writer uses setWithAck.
    ;(window as unknown as { api: unknown }).api = {
      ui: { set: () => Promise.resolve(), setWithAck: host.set }
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      store.getState().hydratePersistedUI({ ...getDefaultUIState() }, 'startup')
    })
    act(() => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(() => {
            usePersistedUIWriter()
            return null
          })
        )
      )
    })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.useRealTimers()
  })

  it('quarantines the refused keys and still lands the batch-mates', async () => {
    act(() => {
      store.getState().setSessionsGridZoom(1.2)
      store.getState().setSidebarWidth(320)
    })
    await flush()
    // The first batch carried both and was refused as a whole.
    expect(host.sets[0]).toEqual({ sessionsGridZoom: 1.2, sidebarWidth: 320 })
    expect(host.ui.sidebarWidth).toBeUndefined()

    // The trailing flush re-sends only the batch-mate; the grid key is folded, not dirty.
    await flush()
    expect(host.ui.sidebarWidth).toBe(320)
    expect(dirtyFields()).toEqual([])
    expect(store.getState().persistedUIWriteInFlightCounts).toEqual({})
    expect(store.getState().sessionsGridZoom).toBe(1.2)

    // A later unrelated edit must not drag the refused key back into the patch.
    act(() => {
      store.getState().setHideDefaultBranchWorkspace(true)
    })
    await flush()
    expect(host.sets.at(-1)).toEqual({ hideDefaultBranchWorkspace: true })
    expect(host.ui.hideDefaultBranchWorkspace).toBe(true)
    // The ack's trailing pass finds nothing dirty and sends nothing more.
    const sends = host.sets.length
    await flush()
    expect(host.sets).toHaveLength(sends)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not loop on a refused key with no batch-mates', async () => {
    act(() => {
      store.getState().setSessionsGridTabOrder(['a', 'b'])
    })
    await flush()
    expect(host.sets).toHaveLength(1)
    await flush()
    await flush()
    expect(host.sets).toHaveLength(1)
    expect(dirtyFields()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
