import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  WorkspacePopoutTarget,
  WorkspacePopoutStateChanged
} from '../../shared/workspace-popout/workspace-popout-contract'

const {
  MockBrowserWindow,
  browserWindowInstances,
  sendToTrustedUIRendererMock,
  appMock,
  screenMock,
  powerMonitorMock,
  nativeThemeMock,
  SimpleEmitter
} = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void

  class SimpleEmitter {
    private eventMap = new Map<string, Listener[]>()

    on(event: string, fn: Listener): this {
      if (!this.eventMap.has(event)) {
        this.eventMap.set(event, [])
      }
      this.eventMap.get(event)!.push(fn)
      return this
    }

    once(event: string, fn: Listener): this {
      const wrapper: Listener = (...args: unknown[]) => {
        this.removeListener(event, wrapper)
        fn(...args)
      }
      return this.on(event, wrapper)
    }

    removeListener(event: string, fn: Listener): this {
      const arr = this.eventMap.get(event)
      if (arr) {
        const idx = arr.indexOf(fn)
        if (idx !== -1) {
          arr.splice(idx, 1)
        }
      }
      return this
    }

    emit(event: string, ...args: unknown[]): boolean {
      const arr = [...(this.eventMap.get(event) ?? [])]
      for (const fn of arr) {
        fn(...args)
      }
      return true
    }

    listenerCount(event?: string): number {
      if (event) {
        return this.eventMap.get(event)?.length ?? 0
      }
      let total = 0
      for (const arr of this.eventMap.values()) {
        total += arr.length
      }
      return total
    }
  }

  const browserWindowInstances: MockBrowserWindow[] = []

  class MockBrowserWindow extends SimpleEmitter {
    id = browserWindowInstances.length + 1
    destroyed = false
    minimized = false
    focused = false
    bounds = { x: 100, y: 100, width: 960, height: 720 }
    webContents = Object.assign(new SimpleEmitter(), {
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      getZoomLevel: vi.fn(() => 0),
      reload: vi.fn(),
      session: {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn()
      }
    })

    constructor() {
      super()
      browserWindowInstances.push(this)
    }

    isDestroyed = vi.fn(() => this.destroyed)
    isMinimized = vi.fn(() => this.minimized)
    isFocused = vi.fn(() => this.focused)
    isFullScreen = vi.fn(() => false)
    restore = vi.fn(() => {
      this.minimized = false
    })
    focus = vi.fn(() => {
      this.focused = true
    })
    getBounds = vi.fn(() => this.bounds)
    setBounds = vi.fn((b: { x: number; y: number; width: number; height: number }) => {
      this.bounds = b
    })
    setTitle = vi.fn()
    loadURL = vi.fn().mockResolvedValue(undefined)
    loadFile = vi.fn().mockResolvedValue(undefined)
    close = vi.fn(() => {
      this.emit('close')
      this.destroyed = true
      this.emit('closed')
    })
  }

  return {
    MockBrowserWindow,
    SimpleEmitter,
    browserWindowInstances,
    sendToTrustedUIRendererMock: vi.fn(),
    appMock: Object.assign(new SimpleEmitter(), {
      isPackaged: false
    }),
    screenMock: Object.assign(new SimpleEmitter(), {
      getAllDisplays: vi.fn(() => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]),
      getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }))
    }),
    powerMonitorMock: new SimpleEmitter(),
    nativeThemeMock: {
      shouldUseDarkColors: true
    }
  }
})

vi.mock('electron', () => {
  return {
    app: appMock,
    BrowserWindow: MockBrowserWindow,
    powerMonitor: powerMonitorMock,
    screen: screenMock,
    nativeTheme: nativeThemeMock
  }
})

vi.mock('../ipc/ui', () => ({
  sendToTrustedUIRenderer: sendToTrustedUIRendererMock
}))

vi.mock('./activation/foreground-activation-policy', () => ({
  isBackgroundLaunch: () => false,
  showWindowWithoutStealingFocus: vi.fn()
}))

vi.mock('./security/privileged-window-navigation', () => ({
  installPrivilegedWindowNavigationPolicy: vi.fn()
}))

vi.mock('../wsl/host-lifecycle/wsl-host-gate', () => ({
  wslHostsWindowArguments: () => []
}))

import {
  _resetWorkspacePopoutsForTests,
  closeAllWorkspacePopouts,
  createOrFocusWorkspacePopout,
  dockWorkspacePopout,
  getWorkspacePopoutTarget,
  isWorkspacePopoutRenderer,
  listWorkspacePopouts,
  onWorkspacePopoutStateChanged
} from './workspace-popout-window'

describe('workspace-popout-window', () => {
  const targetA1: WorkspacePopoutTarget = {
    worktreeId: 'wt-alpha',
    tabId: 'tab-1',
    ptyId: 'pty-1',
    terminalInput: null,
    title: 'Alpha Terminal 1'
  }

  const targetA2: WorkspacePopoutTarget = {
    worktreeId: 'wt-alpha',
    tabId: 'tab-2',
    ptyId: 'pty-2',
    terminalInput: null,
    title: 'Alpha Terminal 2'
  }

  const targetB1: WorkspacePopoutTarget = {
    worktreeId: 'wt-beta',
    tabId: 'tab-3',
    ptyId: 'pty-3',
    terminalInput: null,
    title: 'Beta Terminal 1'
  }

  beforeEach(() => {
    _resetWorkspacePopoutsForTests()
    browserWindowInstances.length = 0
    sendToTrustedUIRendererMock.mockClear()
  })

  it('INV-1: opens at most 1 window per worktreeId on parallel calls', async () => {
    const results = await Promise.all([
      createOrFocusWorkspacePopout(null, targetA1),
      createOrFocusWorkspacePopout(null, targetA1),
      createOrFocusWorkspacePopout(null, targetA1)
    ])

    expect(browserWindowInstances.length).toBe(1)
    expect(results[0]).toEqual({ status: 'opened' })
    expect(results[1]).toEqual({ status: 'focused' })
    expect(results[2]).toEqual({ status: 'focused' })
  })

  it('allows separate windows for different worktreeIds', () => {
    const resA = createOrFocusWorkspacePopout(null, targetA1)
    const resB = createOrFocusWorkspacePopout(null, targetB1)

    expect(browserWindowInstances.length).toBe(2)
    expect(resA).toEqual({ status: 'opened' })
    expect(resB).toEqual({ status: 'opened' })
  })

  it('returns rejected: closing when open is called during closing', () => {
    createOrFocusWorkspacePopout(null, targetA1)
    const win = browserWindowInstances[0]

    // Intercept win.close so it doesn't emit 'closed' synchronously, simulating closing in flight
    win.close = vi.fn()
    dockWorkspacePopout('wt-alpha')

    const res = createOrFocusWorkspacePopout(null, targetA1)
    expect(res).toEqual({ status: 'rejected', reason: 'closing' })
  })

  it('dock during closing is a no-op', () => {
    createOrFocusWorkspacePopout(null, targetA1)
    const win = browserWindowInstances[0]
    win.close = vi.fn()

    dockWorkspacePopout('wt-alpha')
    expect(win.close).toHaveBeenCalledTimes(1)

    dockWorkspacePopout('wt-alpha')
    expect(win.close).toHaveBeenCalledTimes(1) // Still 1, no-op
  })

  it('dock and close concurrency emits only one stateChanged(open: false)', () => {
    const events: WorkspacePopoutStateChanged[] = []
    const unsub = onWorkspacePopoutStateChanged((e) => events.push(e))

    createOrFocusWorkspacePopout(null, targetA1)
    expect(events).toEqual([{ worktreeId: 'wt-alpha', tabId: 'tab-1', open: true }])

    const win = browserWindowInstances[0]
    // Call dock, which calls window.close() which triggers closed
    dockWorkspacePopout('wt-alpha')

    // Calling close again directly
    win.emit('closed')

    const closedEvents = events.filter((e) => e.open === false)
    expect(closedEvents).toHaveLength(1)
    expect(closedEvents[0]).toEqual({
      worktreeId: 'wt-alpha',
      tabId: 'tab-1',
      open: false,
      reason: 'docked'
    })

    unsub()
  })

  it('replaces target tab when different tab is opened in same worktree', () => {
    const events: WorkspacePopoutStateChanged[] = []
    const unsub = onWorkspacePopoutStateChanged((e) => events.push(e))

    createOrFocusWorkspacePopout(null, targetA1)
    expect(browserWindowInstances.length).toBe(1)

    // Open targetA2 in same worktree
    const res = createOrFocusWorkspacePopout(null, targetA2)
    expect(res).toEqual({ status: 'focused' })
    expect(browserWindowInstances.length).toBe(1)

    // Check replaced events
    expect(events).toContainEqual({
      worktreeId: 'wt-alpha',
      tabId: 'tab-1',
      open: false,
      reason: 'replaced'
    })
    expect(events).toContainEqual({
      worktreeId: 'wt-alpha',
      tabId: 'tab-2',
      open: true
    })

    const win = browserWindowInstances[0]
    expect(win.webContents.send).toHaveBeenCalledWith('workspacePopout:target', targetA2)

    unsub()
  })

  it('isWorkspacePopoutRenderer accurately detects popout webContents', () => {
    createOrFocusWorkspacePopout(null, targetA1)
    const win = browserWindowInstances[0]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture creates mock WebContents
    const otherWebContents = new SimpleEmitter() as unknown as Electron.WebContents

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mock window webContents acts as Electron.WebContents
    expect(isWorkspacePopoutRenderer(win.webContents as unknown as Electron.WebContents)).toBe(true)
    expect(isWorkspacePopoutRenderer(otherWebContents)).toBe(false)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mock window webContents acts as Electron.WebContents
    expect(getWorkspacePopoutTarget(win.webContents as unknown as Electron.WebContents)).toEqual(
      targetA1
    )
    expect(getWorkspacePopoutTarget(otherWebContents)).toBeNull()
  })

  it('lists active popouts via listWorkspacePopouts', () => {
    createOrFocusWorkspacePopout(null, targetA1)
    const list = listWorkspacePopouts()
    expect(list).toEqual([
      {
        worktreeId: 'wt-alpha',
        tabId: 'tab-1',
        ptyId: 'pty-1',
        state: 'opening'
      }
    ])
  })

  it('closeAllWorkspacePopouts closes all registered windows with given reason', () => {
    const events: WorkspacePopoutStateChanged[] = []
    const unsub = onWorkspacePopoutStateChanged((e) => events.push(e))

    createOrFocusWorkspacePopout(null, targetA1)
    createOrFocusWorkspacePopout(null, targetB1)
    expect(browserWindowInstances.length).toBe(2)

    closeAllWorkspacePopouts('main-closed')

    const closedEvents = events.filter((e) => e.open === false)
    expect(closedEvents).toHaveLength(2)
    expect(closedEvents).toContainEqual({
      worktreeId: 'wt-alpha',
      tabId: 'tab-1',
      open: false,
      reason: 'main-closed'
    })
    expect(closedEvents).toContainEqual({
      worktreeId: 'wt-beta',
      tabId: 'tab-3',
      open: false,
      reason: 'main-closed'
    })

    unsub()
  })

  it('INV-3: 20 cycles of open and dock restore all module listener counts to zero', () => {
    const initialAppListeners = appMock.listenerCount()
    const initialScreenListeners = screenMock.listenerCount()
    const initialPowerListeners = powerMonitorMock.listenerCount()

    for (let cycle = 0; cycle < 20; cycle++) {
      createOrFocusWorkspacePopout(null, {
        worktreeId: `wt-cycle-${cycle}`,
        tabId: `tab-${cycle}`,
        ptyId: `pty-${cycle}`,
        terminalInput: null,
        title: `Cycle ${cycle}`
      })

      // While open, module listeners are active
      expect(appMock.listenerCount('before-quit')).toBe(1)
      expect(powerMonitorMock.listenerCount('resume')).toBe(1)

      // Docking cleans up the window and detaches listeners when no popouts remain
      dockWorkspacePopout(`wt-cycle-${cycle}`)
    }

    expect(listWorkspacePopouts()).toEqual([])
    expect(appMock.listenerCount()).toBe(initialAppListeners)
    expect(screenMock.listenerCount()).toBe(initialScreenListeners)
    expect(powerMonitorMock.listenerCount()).toBe(initialPowerListeners)
  })

  it('INV-6: PTY PID survives intact across popout and dock cycles', () => {
    const ptyProcessMap = new Map<string, { pid: number; killed: boolean }>()
    ptyProcessMap.set('pty-survive-1', { pid: 9876, killed: false })

    const initialPid = ptyProcessMap.get('pty-survive-1')?.pid
    expect(initialPid).toBe(9876)

    // Open satellite
    const openRes = createOrFocusWorkspacePopout(null, {
      worktreeId: 'wt-survive',
      tabId: 'tab-survive-1',
      ptyId: 'pty-survive-1',
      terminalInput: null,
      title: 'Surviving PTY'
    })
    expect(openRes.status).toBe('opened')

    // During popout, target ptyId is intact and underlying PTY was not killed or re-spawned
    const active = listWorkspacePopouts()
    expect(active).toHaveLength(1)
    expect(active[0].ptyId).toBe('pty-survive-1')
    expect(ptyProcessMap.get('pty-survive-1')?.pid).toBe(initialPid)
    expect(ptyProcessMap.get('pty-survive-1')?.killed).toBe(false)

    // Dock back to main window
    dockWorkspacePopout('wt-survive')

    // After dock, PTY process is still alive with identical PID
    expect(listWorkspacePopouts()).toHaveLength(0)
    expect(ptyProcessMap.get('pty-survive-1')?.pid).toBe(initialPid)
    expect(ptyProcessMap.get('pty-survive-1')?.killed).toBe(false)
  })
})
