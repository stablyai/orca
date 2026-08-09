import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Display = { workArea: { x: number; y: number; width: number; height: number } }

const {
  instances,
  BrowserWindowMock,
  nativeThemeMock,
  appOnMock,
  appRemoveListenerMock,
  getAllDisplaysMock,
  installNavigationPolicyMock
} = vi.hoisted(() => {
  const created: FakeWindow[] = []

  class FakeWindow {
    options: Electron.BrowserWindowConstructorOptions
    private handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
    private onceHandlers: Record<string, ((...args: unknown[]) => void)[]> = {}
    destroyed = false
    minimized = false
    fullscreen = false
    focused = false
    private webContentsHandlers: Record<string, ((...args: unknown[]) => void)[]> = {}
    webContents = {
      id: created.length + 1,
      send: vi.fn(),
      isDestroyed: () => this.destroyed,
      session: {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn()
      },
      on: (event: string, cb: (...args: unknown[]) => void) => {
        ;(this.webContentsHandlers[event] ||= []).push(cb)
      },
      setZoomLevel: vi.fn(),
      getZoomLevel: vi.fn(() => 0)
    }
    bounds = { x: 100, y: 100, width: 960, height: 720 }
    focus = vi.fn()
    show = vi.fn()
    restore = vi.fn(() => {
      this.minimized = false
    })
    loadURL = vi.fn()
    loadFile = vi.fn()
    close = vi.fn(() => {
      this.destroyed = true
      this.emit('close')
      this.emit('closed')
    })
    destroy = vi.fn(() => {
      this.destroyed = true
    })

    constructor(options: Electron.BrowserWindowConstructorOptions) {
      this.options = options
      created.push(this)
    }

    on(event: string, cb: (...args: unknown[]) => void): this {
      ;(this.handlers[event] ||= []).push(cb)
      return this
    }

    once(event: string, cb: (...args: unknown[]) => void): this {
      ;(this.onceHandlers[event] ||= []).push(cb)
      return this
    }

    emit(event: string, ...args: unknown[]): void {
      for (const cb of this.handlers[event] ?? []) {
        cb(...args)
      }
      for (const cb of this.onceHandlers[event] ?? []) {
        cb(...args)
      }
    }

    isDestroyed(): boolean {
      return this.destroyed
    }
    isFocused(): boolean {
      return this.focused
    }
    isMinimized(): boolean {
      return this.minimized
    }
    isFullScreen(): boolean {
      return this.fullscreen
    }
    getBounds(): { x: number; y: number; width: number; height: number } {
      return this.bounds
    }
  }

  return {
    instances: created,
    BrowserWindowMock: FakeWindow,
    nativeThemeMock: { shouldUseDarkColors: true },
    appOnMock: vi.fn(),
    appRemoveListenerMock: vi.fn(),
    getAllDisplaysMock: vi.fn((): Display[] => [
      { workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
    ]),
    installNavigationPolicyMock: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: { on: appOnMock, removeListener: appRemoveListenerMock },
  BrowserWindow: BrowserWindowMock,
  nativeTheme: nativeThemeMock,
  screen: { getAllDisplays: getAllDisplaysMock }
}))

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

vi.mock('./privileged-window-navigation', () => ({
  installPrivilegedWindowNavigationPolicy: installNavigationPolicyMock
}))

import { DetachablePaneWindowManager } from './detachable-pane-window-manager'
import { InvalidDetachablePaneWindowTransitionError } from './detachable-pane-window'
import type { Store } from '../persistence'
import type { DetachedTerminalTabSeed } from '../../shared/types'

type FakeWindow = InstanceType<typeof BrowserWindowMock>

function makeSeed(): DetachedTerminalTabSeed {
  return {
    tab: { id: 'tab-1' } as unknown as DetachedTerminalTabSeed['tab'],
    layout: { root: null, activeLeafId: null, expandedLeafId: null },
    ptyId: 'pty-1',
    worktreeId: 'wt-1',
    groupId: 'group-1',
    repo: {
      id: 'wt-1',
      path: '/repo',
      displayName: 'Repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: null,
      executionHostId: null
    }
  }
}

function makeStore(ui: Record<string, unknown> = {}): {
  getUI: () => Record<string, unknown>
  updateUI: ReturnType<typeof vi.fn>
} {
  return {
    getUI: () => ui,
    updateUI: vi.fn()
  }
}

describe('DetachablePaneWindowManager', () => {
  let manager: DetachablePaneWindowManager

  beforeEach(() => {
    instances.length = 0
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
    getAllDisplaysMock.mockReturnValue([{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }])
    manager = new DetachablePaneWindowManager()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('reports null state for unknown pane', () => {
    expect(manager.getPaneState('nonexistent')).toBeNull()
  })

  // ── Detach ────────────────────────────────────────────────────────

  it('detaches a pane by creating a BrowserWindow', () => {
    const store = makeStore()
    manager.detachPane('pane-1', store as unknown as Store)

    expect(instances).toHaveLength(1)
    const opts = instances[0].options
    expect(opts.title).toBe('Orca Detached Pane')
    expect(opts.minWidth).toBe(480)
    expect(opts.minHeight).toBe(360)
    expect(opts.webPreferences?.sandbox).toBe(true)
    expect(opts.webPreferences?.partition).toBe('persist:orca-detachable-pane-pane-1')
    expect(opts.webPreferences?.webviewTag).toBe(false)
    expect(opts.webPreferences?.preload).toMatch(/preload[\\/]index\.js$/)
    expect(installNavigationPolicyMock).toHaveBeenCalledWith(instances[0].webContents)
  })

  it('transitions to detached state after detach', () => {
    manager.detachPane('pane-1', makeStore() as unknown as Store)
    expect(manager.getPaneState('pane-1')).toBe('detached')
  })

  it('returns the live window after detach', () => {
    manager.detachPane('pane-1', makeStore() as unknown as Store)
    const win = manager.getPaneWindow('pane-1')
    expect(win).toBe(instances[0])
    expect(win?.isDestroyed()).toBe(false)
  })

  it('returns null for destroyed window', () => {
    manager.detachPane('pane-1', makeStore() as unknown as Store)
    instances[0].destroyed = true
    expect(manager.getPaneWindow('pane-1')).toBeNull()
  })

  it("isPaneWindowSender: recognizes the pane window's own webContents", () => {
    manager.detachPane('pane-1', makeStore() as unknown as Store)
    const sender = instances[0].webContents as unknown as Electron.WebContents
    expect(manager.isPaneWindowSender('pane-1', sender)).toBe(true)
  })

  it('isPaneWindowSender: rejects a webContents from a different pane', () => {
    manager.detachPane('pane-1', makeStore() as unknown as Store)
    manager.detachPane('pane-2', makeStore() as unknown as Store)
    const otherSender = instances[1].webContents as unknown as Electron.WebContents
    expect(manager.isPaneWindowSender('pane-1', otherSender)).toBe(false)
  })

  it('isPaneWindowSender: rejects once the pane window is destroyed', () => {
    manager.detachPane('pane-1', makeStore() as unknown as Store)
    const sender = instances[0].webContents as unknown as Electron.WebContents
    instances[0].destroyed = true
    expect(manager.isPaneWindowSender('pane-1', sender)).toBe(false)
  })

  it('idempotent detach returns existing window', () => {
    const store = makeStore()
    const first = manager.detachPane('pane-1', store as unknown as Store)
    const second = manager.detachPane('pane-1', store as unknown as Store)
    expect(instances).toHaveLength(1)
    expect(second).toBe(first)
  })

  it('shows the window on ready-to-show', () => {
    manager.detachPane('pane-1', makeStore() as unknown as Store)
    const win = instances[0] as unknown as FakeWindow
    expect(win.show).not.toHaveBeenCalled()
    win.emit('ready-to-show')
    expect(win.show).toHaveBeenCalledTimes(1)
  })

  it('rolls back to a retryable state when window creation throws', () => {
    installNavigationPolicyMock.mockImplementationOnce(() => {
      throw new Error('boom')
    })

    expect(() => manager.detachPane('pane-1', makeStore() as unknown as Store)).toThrow('boom')
    expect(manager.getPaneState('pane-1')).toBeNull()

    const win = manager.detachPane('pane-1', makeStore() as unknown as Store)
    expect(manager.getPaneState('pane-1')).toBe('detached')
    expect(win).toBe(instances[1])
  })

  // ── Detach errors ─────────────────────────────────────────────────

  it('rejects detach on pane already transferring', () => {
    // Force lifecycle into transferring state by creating an incomplete detach.
    // We can't directly set transferring from the outside, but we CAN trigger
    // it: detach transitions attached -> transferring -> detached atomically.
    // To test a rejected transition, we reintegrate then try a race.

    // Actually: just test that a duplicate detach while transferring or parked
    // is rejected. After parking (via close), detach should fail.
    manager.detachPane('pane-1', makeStore() as unknown as Store)
    // Close the window → parked
    ;(instances[0] as unknown as FakeWindow).close()
    expect(manager.getPaneState('pane-1')).toBe('parked')

    expect(() => manager.detachPane('pane-1', makeStore() as unknown as Store)).toThrow(
      InvalidDetachablePaneWindowTransitionError
    )
  })

  // ── Reintegrate ───────────────────────────────────────────────────

  it('reintegrates a detached pane, closing its window', () => {
    manager.detachPane('pane-1', makeStore() as unknown as Store)
    expect(manager.getPaneState('pane-1')).toBe('detached')

    manager.reintegratePane('pane-1')
    expect(manager.getPaneState('pane-1')).toBeNull()
    expect(instances[0].isDestroyed()).toBe(true)
  })

  it('reintegrates a parked pane (no window to close)', () => {
    manager.detachPane('pane-1', makeStore() as unknown as Store)
    ;(instances[0] as unknown as FakeWindow).close()
    expect(manager.getPaneState('pane-1')).toBe('parked')

    manager.reintegratePane('pane-1')
    expect(manager.getPaneState('pane-1')).toBeNull()
  })

  it('rejects reintegrate on attached pane', () => {
    expect(() => manager.reintegratePane('nonexistent')).toThrow(
      InvalidDetachablePaneWindowTransitionError
    )
  })

  it('rejects reintegrate on already-reintegrated pane', () => {
    manager.detachPane('pane-1', makeStore() as unknown as Store)
    manager.reintegratePane('pane-1')
    expect(() => manager.reintegratePane('pane-1')).toThrow(
      InvalidDetachablePaneWindowTransitionError
    )
  })

  // ── Multi-pane isolation ──────────────────────────────────────────

  it('manages multiple panes independently', () => {
    const store = makeStore()
    manager.detachPane('pane-a', store as unknown as Store)
    manager.detachPane('pane-b', store as unknown as Store)

    expect(instances).toHaveLength(2)
    expect(manager.getPaneState('pane-a')).toBe('detached')
    expect(manager.getPaneState('pane-b')).toBe('detached')

    // Different partitions
    expect(instances[0].options.webPreferences?.partition).toBe(
      'persist:orca-detachable-pane-pane-a'
    )
    expect(instances[1].options.webPreferences?.partition).toBe(
      'persist:orca-detachable-pane-pane-b'
    )
  })

  it('reintegrating one pane does not affect the other', () => {
    manager.detachPane('pane-a', makeStore() as unknown as Store)
    manager.detachPane('pane-b', makeStore() as unknown as Store)

    manager.reintegratePane('pane-a')
    expect(manager.getPaneState('pane-a')).toBeNull()
    expect(manager.getPaneState('pane-b')).toBe('detached')
  })

  it('no map entry leaked after reintegrate', () => {
    manager.detachPane('pane-1', makeStore() as unknown as Store)
    manager.reintegratePane('pane-1')
    expect(manager.getPaneState('pane-1')).toBeNull()
    expect(manager.getPaneWindow('pane-1')).toBeNull()
  })

  // ── Parking via native close ──────────────────────────────────────

  it('parks a pane when the window is closed natively', () => {
    manager.detachPane('pane-1', makeStore() as unknown as Store)
    const win = instances[0] as unknown as FakeWindow
    win.close()

    expect(manager.getPaneState('pane-1')).toBe('parked')
    expect(manager.getPaneWindow('pane-1')).toBeNull()
  })

  it('parked pane can still be reintegrated', () => {
    manager.detachPane('pane-1', makeStore() as unknown as Store)
    ;(instances[0] as unknown as FakeWindow).close()
    expect(manager.getPaneState('pane-1')).toBe('parked')

    manager.reintegratePane('pane-1')
    expect(manager.getPaneState('pane-1')).toBeNull()
  })

  // ── Bounds persistence ────────────────────────────────────────────

  it('saves bounds to store debounced', () => {
    vi.useFakeTimers()
    const store = makeStore()
    manager.detachPane('pane-1', store as unknown as Store)
    const win = instances[0] as unknown as FakeWindow

    win.bounds = { x: 200, y: 300, width: 800, height: 600 }
    win.emit('resize')

    vi.advanceTimersByTime(600)

    expect(store.updateUI).toHaveBeenCalledWith({
      detachablePaneBounds: {
        'pane-1': { x: 200, y: 300, width: 800, height: 600 }
      }
    })
    vi.useRealTimers()
  })

  it('restores saved bounds from store', () => {
    const store = makeStore({
      detachablePaneBounds: {
        'pane-1': { x: 150, y: 250, width: 900, height: 700 }
      }
    })
    manager.detachPane('pane-1', store as unknown as Store)
    const opts = instances[0].options
    expect(opts.x).toBe(150)
    expect(opts.y).toBe(250)
    expect(opts.width).toBe(900)
    expect(opts.height).toBe(700)
  })

  it('preserves other panes bounds when saving one pane', () => {
    vi.useFakeTimers()
    const store = makeStore({
      detachablePaneBounds: {
        'pane-other': { x: 10, y: 20, width: 500, height: 400 }
      }
    })
    manager.detachPane('pane-1', store as unknown as Store)
    const win = instances[0] as unknown as FakeWindow

    win.bounds = { x: 200, y: 300, width: 800, height: 600 }
    win.emit('resize')
    vi.advanceTimersByTime(600)

    expect(store.updateUI).toHaveBeenCalledWith({
      detachablePaneBounds: {
        'pane-other': { x: 10, y: 20, width: 500, height: 400 },
        'pane-1': { x: 200, y: 300, width: 800, height: 600 }
      }
    })
    vi.useRealTimers()
  })

  it('ignores saved bounds below minimum size', () => {
    const store = makeStore({
      detachablePaneBounds: {
        'pane-1': { x: 0, y: 0, width: 100, height: 100 }
      }
    })
    manager.detachPane('pane-1', store as unknown as Store)
    const opts = instances[0].options
    expect(opts.width).toBe(960)
    expect(opts.height).toBe(720)
  })

  // ── Partition scoped per pane id ──────────────────────────────────

  it('uses pane-id-scoped partition', () => {
    manager.detachPane('my-pane', makeStore() as unknown as Store)
    expect(instances[0].options.webPreferences?.partition).toBe(
      'persist:orca-detachable-pane-my-pane'
    )
  })

  // ── Detached-tab seed ──────────────────────────────────────────────────

  it('returns null seed for a pane with no seed set', () => {
    expect(manager.getPaneSeed('pane-1')).toBeNull()
  })

  it('stores the seed passed to detachPane and retrieves it', () => {
    manager.detachPane('pane-1', makeStore() as unknown as Store, makeSeed())
    expect(manager.getPaneSeed('pane-1')).toEqual(makeSeed())
  })

  it('keeps the seed available after the pane parks via native close', () => {
    manager.detachPane('pane-1', makeStore() as unknown as Store, makeSeed())
    ;(instances[0] as unknown as FakeWindow).close()
    expect(manager.getPaneState('pane-1')).toBe('parked')
    expect(manager.getPaneSeed('pane-1')).toEqual(makeSeed())
  })

  it('clears the seed once the pane fully reintegrates', () => {
    manager.detachPane('pane-1', makeStore() as unknown as Store, makeSeed())
    manager.reintegratePane('pane-1')
    expect(manager.getPaneSeed('pane-1')).toBeNull()
  })

  it('drops the seed when window creation throws on a fresh detach', () => {
    installNavigationPolicyMock.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expect(() => manager.detachPane('pane-1', makeStore() as unknown as Store, makeSeed())).toThrow(
      'boom'
    )
    expect(manager.getPaneSeed('pane-1')).toBeNull()
  })

  // ── removeTab ─────────────────────────────────────────────────────

  it('removeTab: removes the primary tab and promotes the first additional tab', () => {
    const seed = makeSeed()
    const additional = makeSeed()
    additional.tab = { id: 'tab-2' } as unknown as DetachedTerminalTabSeed['tab']
    additional.ptyId = 'pty-2'
    seed.additionalTabs = [additional]

    manager.detachPane('pane-1', makeStore() as unknown as Store, seed)

    const result = manager.removeTab('pane-1', 'tab-1')
    expect(result.removedPtyId).toBe('pty-1')
    expect(result.seed).not.toBeNull()
    expect(result.seed!.tab.id).toBe('tab-2')
    expect(result.seed!.ptyId).toBe('pty-2')
    expect(result.seed!.additionalTabs).toBeUndefined()

    // Manager stored seed matches returned seed.
    expect(manager.getPaneSeed('pane-1')).toEqual(result.seed)
  })

  it('removeTab: removes an additional tab', () => {
    const seed = makeSeed()
    const additional = makeSeed()
    additional.tab = { id: 'tab-2' } as unknown as DetachedTerminalTabSeed['tab']
    additional.ptyId = 'pty-2'
    seed.additionalTabs = [additional]

    manager.detachPane('pane-1', makeStore() as unknown as Store, seed)

    const result = manager.removeTab('pane-1', 'tab-2')
    expect(result.removedPtyId).toBe('pty-2')
    expect(result.seed).not.toBeNull()
    expect(result.seed!.tab.id).toBe('tab-1')
    expect(result.seed!.additionalTabs).toBeUndefined()

    expect(manager.getPaneSeed('pane-1')).toEqual(result.seed)
  })

  it('removeTab: returns null seed when the last tab is removed', () => {
    manager.detachPane('pane-1', makeStore() as unknown as Store, makeSeed())

    const result = manager.removeTab('pane-1', 'tab-1')
    expect(result.removedPtyId).toBe('pty-1')
    expect(result.seed).toBeNull()
    expect(manager.getPaneSeed('pane-1')).toBeNull()
  })

  it('removeTab: returns null seed and null removedPtyId for unknown paneId', () => {
    const result = manager.removeTab('nonexistent', 'tab-1')
    expect(result.seed).toBeNull()
    expect(result.removedPtyId).toBeNull()
  })

  it('removeTab: returns null seed and null removedPtyId for unknown tabId', () => {
    manager.detachPane('pane-1', makeStore() as unknown as Store, makeSeed())

    const result = manager.removeTab('pane-1', 'nonexistent-tab')
    expect(result.seed).toBeNull()
    expect(result.removedPtyId).toBeNull()
    // Seed is unchanged.
    expect(manager.getPaneSeed('pane-1')).toEqual(makeSeed())
  })

  it('removeTab: returns null removedPtyId when the removed tab has no PTY', () => {
    const seed = makeSeed()
    seed.ptyId = null
    manager.detachPane('pane-1', makeStore() as unknown as Store, seed)

    const result = manager.removeTab('pane-1', 'tab-1')
    expect(result.removedPtyId).toBeNull()
    expect(result.seed).toBeNull()
  })

  it('removeTab: pane entry survives removeTab so reintegrate still works afterward', () => {
    manager.detachPane('pane-1', makeStore() as unknown as Store, makeSeed())
    manager.removeTab('pane-1', 'tab-1')

    // The pane entry still exists (seed is null, but the entry is there for
    // the lifecycle) — reintegrating should still clean up.
    expect(manager.getPaneState('pane-1')).toBe('detached')
    manager.reintegratePane('pane-1')
    expect(manager.getPaneState('pane-1')).toBeNull()
  })
})
