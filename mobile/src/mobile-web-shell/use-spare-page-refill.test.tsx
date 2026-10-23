import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaMobileWebShellSparesModule } from '../../modules/orca-mobile-web-shell/src/spares'
import type { MobileWebBundleManifestRead } from '../transport/mobile-web-bundle-reply-schemas'
import { deriveHostCacheKey } from './host-cache-key'
import type { GenerationStore } from './generation-store'
import type { MobileWebShellRuntime } from './mobile-web-shell-runtime'

const appState = vi.hoisted(() => ({
  current: 'active',
  listeners: new Set<(state: string) => void>()
}))
const screen = vi.hoisted(() => ({ focused: true }))

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appState.current
    },
    addEventListener: (_: string, listener: (state: string) => void) => {
      appState.listeners.add(listener)
      return { remove: () => appState.listeners.delete(listener) }
    }
  }
}))
vi.mock('expo-router', () => ({ useIsFocused: () => screen.focused }))
vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: '' } }))

import { SPARE_REFILL_DELAY_MS, useSparePageRefill } from './use-spare-page-refill'

type Props = { painted: boolean; ownsHostArea: boolean; runtime: MobileWebShellRuntime }

function Probe(props: Props) {
  useSparePageRefill({ hostId: 'host-1', generationDirectory: '/gen/b', ...props })
  return null
}

const manifest: MobileWebBundleManifestRead = {
  schemaVersion: 1,
  buildId: 'b'.repeat(64),
  minCompatibleRuntimeProtocolVersion: 2,
  runtimeProtocolVersion: 5,
  pageVersion: 1,
  entrypoint: 'index.html',
  totalBytes: 2048,
  assets: [
    { path: 'index.html', sha256: 'c'.repeat(64), byteLength: 2048, contentType: 'text/html' }
  ],
  routes: [{ pathname: '/h/[hostId]', grants: ['navigate'] }]
}

/** The host's current generation, as the store has it. */
let activeDirectory = '/gen/b'

function runtimeWith(spares?: OrcaMobileWebShellSparesModule): { runtime: MobileWebShellRuntime } {
  let minted = 0
  const store: GenerationStore = {
    readActiveGeneration: async () => ({
      buildId: manifest.buildId,
      directory: activeDirectory,
      manifest
    }),
    openReusableAssets: async () => ({ has: () => false, check: async () => false }),
    stageGeneration: async () => {
      throw new Error('the refill never stages')
    },
    commitGeneration: async () => {
      throw new Error('the refill never commits')
    },
    abortStagedGeneration: async () => undefined,
    sweepStagedGenerations: async () => undefined,
    deleteHostCache: async () => undefined,
    recordUpdateFailure: async () => undefined,
    readUpdateFailures: async () => [],
    forgetHostUpdateFailures: async () => undefined
  }
  return {
    runtime: {
      createStore: () => store,
      mintSessionId: () => `minted-${String((minted += 1))}`,
      ...(spares === undefined ? {} : { spares }),
      now: () => 0,
      setTimer: (run, delayMs) => {
        const handle = setTimeout(run, delayMs)
        return () => clearTimeout(handle)
      }
    }
  }
}

function pool(prepared: string[][]): OrcaMobileWebShellSparesModule {
  return {
    prepareSpare: async (hostKey, directory, sessionId) => {
      prepared.push([hostKey, directory, sessionId])
    },
    takeSpare: async () => null,
    discardSpares: async () => undefined
  }
}

describe('the spare refill', () => {
  let tree: ReactTestRenderer | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    appState.current = 'active'
    appState.listeners.clear()
    screen.focused = true
    activeDirectory = '/gen/b'
  })

  afterEach(() => {
    act(() => tree?.unmount())
    tree = null
    vi.useRealTimers()
  })

  function render(props: Props) {
    act(() => {
      if (tree === null) {
        tree = create(createElement(Probe, props))
      } else {
        tree.update(createElement(Probe, props))
      }
    })
  }

  it('boots one page for this host once the page on screen has painted and settled', async () => {
    const prepared: string[][] = []
    const { runtime } = runtimeWith(pool(prepared))
    render({ painted: false, ownsHostArea: false, runtime })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPARE_REFILL_DELAY_MS * 5)
    })
    expect(prepared).toEqual([])
    render({ painted: true, ownsHostArea: false, runtime })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPARE_REFILL_DELAY_MS - 1)
    })
    expect(prepared).toEqual([])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(prepared).toEqual([[deriveHostCacheKey('host-1'), '/gen/b', 'minted-1']])
  })

  it('boots none for a page that owns the host area, or on a binary without the pool', async () => {
    const prepared: string[][] = []
    render({ painted: true, ownsHostArea: true, runtime: runtimeWith(pool(prepared)).runtime })
    act(() => tree?.unmount())
    tree = null
    render({ painted: true, ownsHostArea: false, runtime: runtimeWith().runtime })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPARE_REFILL_DELAY_MS * 5)
    })
    expect(prepared).toEqual([])
  })

  it('waits while the app is in the background, and boots again when it comes back', async () => {
    const prepared: string[][] = []
    const { runtime } = runtimeWith(pool(prepared))
    render({ painted: true, ownsHostArea: false, runtime })
    act(() => {
      for (const listener of appState.listeners) {
        listener('background')
      }
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPARE_REFILL_DELAY_MS * 5)
    })
    expect(prepared).toEqual([])
    act(() => {
      for (const listener of appState.listeners) {
        listener('active')
      }
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPARE_REFILL_DELAY_MS)
    })
    expect(prepared).toHaveLength(1)
  })

  it('boots none from a generation an update replaced, when its screen is shown again', async () => {
    const prepared: string[][] = []
    const { runtime } = runtimeWith(pool(prepared))
    screen.focused = false
    render({ painted: true, ownsHostArea: false, runtime })
    activeDirectory = '/gen/c'
    screen.focused = true
    render({ painted: true, ownsHostArea: false, runtime })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPARE_REFILL_DELAY_MS * 5)
    })
    expect(prepared).toEqual([])
  })

  it('boots none when the screen loses focus before the page settles', async () => {
    const prepared: string[][] = []
    const { runtime } = runtimeWith(pool(prepared))
    render({ painted: true, ownsHostArea: false, runtime })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPARE_REFILL_DELAY_MS / 2)
    })
    screen.focused = false
    render({ painted: true, ownsHostArea: false, runtime })
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPARE_REFILL_DELAY_MS * 5)
    })
    expect(prepared).toEqual([])
  })
})
