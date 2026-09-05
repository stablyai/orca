import { describe, expect, it, vi } from 'vitest'
import type { GlassesBridge, GlassesRawEvent } from '../glasses/glasses-bridge'
import { createHudStore, type HudState } from '../state/hud-store'
import { HudInputRouter, type NavPorts } from './hud-input-router'
import type { NavContext } from './nav-contract'

function fixtureState(overrides: Partial<HudState> = {}): HudState {
  return {
    connection: { hostId: null, state: 'disconnected', compat: null },
    hosts: [],
    dashboard: { rows: [], fetchedAt: 0, stale: false },
    inbox: { entries: [] },
    terminalTail: { terminalId: null, lines: [], live: false },
    device: null,
    askAnswered: null,
    nav: { stack: [{ screen: 'hostList', selectedIndex: 0 }], exitDialogArmed: false },
    ...overrides
  }
}

function fixtureCtx(overrides: Partial<NavContext> = {}): NavContext {
  return {
    hostCount: 1,
    worktreeCount: () => 0,
    dashboardPageCount: () => 1,
    worktreeListPageCount: () => 1,
    terminalTailPageCount: () => 1,
    pendingAskNotificationId: () => null,
    askOptionCount: () => 3,
    hostIdAt: () => null,
    worktreeIdAt: () => null,
    notificationWorktreeId: () => null,
    ...overrides
  }
}

/** Minimal GlassesBridge stub: only onRawEvent is exercised by the router. */
function createFakeBridge(): { bridge: GlassesBridge; emit: (event: GlassesRawEvent) => void } {
  let listener: ((event: GlassesRawEvent) => void) | null = null
  const bridge: GlassesBridge = {
    createStartUpPage: () => Promise.resolve('success'),
    rebuildPage: () => Promise.resolve(true),
    upgradeText: () => Promise.resolve(true),
    shutDownPage: () => Promise.resolve(true),
    getDeviceSnapshot: () => Promise.resolve(null),
    setStoredValue: () => Promise.resolve(true),
    getStoredValue: () => Promise.resolve(''),
    onRawEvent: (cb) => {
      listener = cb
      return () => {
        listener = null
      }
    },
    onDeviceStatusChanged: () => () => {}
  }
  return { bridge, emit: (event) => listener?.(event) }
}

function createPorts(): NavPorts & Record<keyof NavPorts, ReturnType<typeof vi.fn>> {
  return {
    shutdownDialog: vi.fn(),
    connectHost: vi.fn(),
    openTerminalTail: vi.fn(),
    closeTerminalTail: vi.fn(),
    sendAskAnswer: vi.fn(),
    refreshDashboard: vi.fn(),
    pausePolling: vi.fn(),
    resumePolling: vi.fn(),
    disconnectHost: vi.fn(),
    invalidateRender: vi.fn(),
    reopenTerminalTail: vi.fn()
  }
}

describe('HudInputRouter', () => {
  it('normalizes a raw click(0-as-undefined) event and applies the resulting effect', () => {
    const store = createHudStore(fixtureState())
    const { bridge, emit } = createFakeBridge()
    const ports = createPorts()
    const router = new HudInputRouter({ bridge, store, ports, buildContext: () => fixtureCtx() })
    router.start()

    // root double-tap requests the shutdown dialog per spec S7.
    emit({ source: 'sys', eventType: 3 }) // DOUBLE_CLICK
    expect(ports.shutdownDialog).toHaveBeenCalledTimes(1)
    expect(store.getState().nav.exitDialogArmed).toBe(true)
  })

  it('routes listSelect through the reducer and calls connectHost', () => {
    const store = createHudStore(fixtureState())
    const { bridge, emit } = createFakeBridge()
    const ports = createPorts()
    const ctx = fixtureCtx({ hostIdAt: (i) => (i === 0 ? 'host-1' : null) })
    const router = new HudInputRouter({ bridge, store, ports, buildContext: () => ctx })
    router.start()

    emit({ source: 'list', eventType: undefined, listItemIndex: 0, listItemName: 'my-host' })

    expect(ports.connectHost).toHaveBeenCalledWith('host-1')
    expect(store.getState().nav.stack.at(-1)).toEqual({
      screen: 'dashboard',
      hostId: 'host-1',
      cursor: 0,
      page: 0
    })
  })

  it('encodes the AskQuickAction to the exact key sequence before calling sendAskAnswer', () => {
    const state = fixtureState({
      nav: {
        stack: [{ screen: 'ask', hostId: 'h1', notificationId: 'n1', selectedOption: 1 }],
        exitDialogArmed: false
      }
    })
    const store = createHudStore(state)
    const { bridge, emit } = createFakeBridge()
    const ports = createPorts()
    const ctx = fixtureCtx({ askOptionCount: () => 3, notificationWorktreeId: () => 'wt-1' })
    const router = new HudInputRouter({ bridge, store, ports, buildContext: () => ctx })
    router.start()

    emit({ source: 'text', eventType: undefined }) // CLICK via undefined-quirk

    expect(ports.sendAskAnswer).toHaveBeenCalledWith('h1', 'wt-1', '2\r')
  })

  it('drops duplicate sys events within the dedupe window (normalizer quirk)', () => {
    const store = createHudStore(fixtureState())
    const { bridge, emit } = createFakeBridge()
    const ports = createPorts()
    let now = 1000
    const router = new HudInputRouter({
      bridge,
      store,
      ports,
      buildContext: () => fixtureCtx(),
      normalizerOptions: { now: () => now }
    })
    router.start()

    emit({ source: 'sys', eventType: 3 })
    now += 100
    emit({ source: 'sys', eventType: 3 }) // within 600ms window -> dropped

    expect(ports.shutdownDialog).toHaveBeenCalledTimes(1)
  })

  it('stop() unsubscribes from the bridge', () => {
    const store = createHudStore(fixtureState())
    const { bridge, emit } = createFakeBridge()
    const ports = createPorts()
    const router = new HudInputRouter({ bridge, store, ports, buildContext: () => fixtureCtx() })
    router.start()
    router.stop()

    emit({ source: 'sys', eventType: 3 })
    expect(ports.shutdownDialog).not.toHaveBeenCalled()
  })

  it('routes invalidateRender and reopenTerminalTail effects to their ports', () => {
    const store = createHudStore(
      fixtureState({
        nav: {
          stack: [
            { screen: 'dashboard', hostId: 'h1', cursor: 0, page: 0 },
            {
              screen: 'terminalTail',
              hostId: 'h1',
              worktreeId: 'wt-1',
              terminalId: 'term-1',
              page: 0
            }
          ],
          exitDialogArmed: false,
          terminalTailsNeedReopen: true
        }
      })
    )
    const { bridge } = createFakeBridge()
    const ports = createPorts()
    const router = new HudInputRouter({ bridge, store, ports, buildContext: () => fixtureCtx() })

    router.dispatch({ kind: 'foregroundEnter' })

    expect(ports.resumePolling).toHaveBeenCalledTimes(1)
    expect(ports.reopenTerminalTail).toHaveBeenCalledWith('wt-1')
  })

  it('dispatch() drives the reducer directly without a bridge event', () => {
    const store = createHudStore(fixtureState())
    const { bridge } = createFakeBridge()
    const ports = createPorts()
    const router = new HudInputRouter({ bridge, store, ports, buildContext: () => fixtureCtx() })

    router.dispatch({ kind: 'doubleClick' })

    expect(ports.shutdownDialog).toHaveBeenCalledTimes(1)
  })
})
