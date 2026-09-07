import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const ui: Record<string, unknown> = {}
  class FakeWebContents {
    readonly id: number
    readonly events = new Map<string, ((...args: unknown[]) => void)[]>()
    readonly send = vi.fn()
    readonly setWindowOpenHandler = vi.fn()

    constructor(id: number) {
      this.id = id
    }

    on(event: string, listener: (...args: unknown[]) => void): void {
      this.events.set(event, [...(this.events.get(event) ?? []), listener])
    }

    isDestroyed(): boolean {
      return false
    }
  }

  const windows: {
    id: number
    webContents: FakeWebContents
    events: Map<string, ((...args: unknown[]) => void)[]>
    emit: (event: string, ...args: unknown[]) => void
    loadURL: ReturnType<typeof vi.fn>
    maximize: ReturnType<typeof vi.fn>
    options: Electron.BrowserWindowConstructorOptions
    destroyed: boolean
  }[] = []

  class FakeWindow {
    readonly id: number
    readonly webContents: FakeWebContents
    readonly events = new Map<string, ((...args: unknown[]) => void)[]>()
    readonly loadURL = vi.fn(async () => {})
    readonly maximize = vi.fn()
    readonly options: Electron.BrowserWindowConstructorOptions
    destroyed = false

    constructor(options: Electron.BrowserWindowConstructorOptions = {}) {
      this.id = windows.length + 10
      this.webContents = new FakeWebContents(this.id + 100)
      this.options = options
      windows.push(this)
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      this.events.set(event, [...(this.events.get(event) ?? []), listener])
      return this
    }

    once(event: string, listener: (...args: unknown[]) => void): this {
      return this.on(event, listener)
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.events.get(event) ?? []) {
        listener(...args)
      }
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    isMaximized(): boolean {
      return false
    }

    getBounds(): Electron.Rectangle {
      return { x: 20, y: 30, width: 1000, height: 700 }
    }
  }

  const store = {
    getSettings: vi.fn(() => ({})),
    getUI: vi.fn(() => ui),
    updateUI: vi.fn((updates: Record<string, unknown>) => Object.assign(ui, updates))
  }
  const state = {
    automations: { setWebContents: vi.fn() },
    isQuitting: false,
    keybindings: { getOverrides: vi.fn(() => undefined) },
    mainWindow: null as FakeWindow | null,
    runtime: {},
    runtimeRpc: {
      getRuntimeId: () => 'local-runtime',
      createPairingOffer: vi.fn(() => ({
        available: true,
        deviceId: 'device-1',
        endpoint: 'ws://127.0.0.1:6768',
        pairingUrl: 'orca://pair',
        webClientUrl: 'http://127.0.0.1:6768/web-index.html?pairing=secret'
      })),
      revokeRuntimeAccess: vi.fn()
    },
    store
  }
  return {
    attachCore: vi.fn(),
    createMainWindow: vi.fn(),
    FakeWindow,
    state,
    store,
    ui,
    windows
  }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'C:/tmp'), getVersion: vi.fn(() => '1.0.0'), name: 'Orca' },
  BrowserWindow: mocks.FakeWindow,
  nativeTheme: { shouldUseDarkColors: false },
  screen: {
    getAllDisplays: vi.fn(() => [
      {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1040 }
      }
    ]),
    getPrimaryDisplay: vi.fn(() => ({ workAreaSize: { width: 1920, height: 1040 } })),
    on: vi.fn(),
    removeListener: vi.fn()
  }
}))
vi.mock('../app-icon', () => ({ getAppIconPath: vi.fn(() => undefined) }))
vi.mock('./createMainWindow', () => ({
  createMainWindow: mocks.createMainWindow,
  loadMainWindow: vi.fn()
}))
vi.mock('../startup/main-window-core-services', () => ({
  attachMainWindowCoreServices: mocks.attachCore
}))
vi.mock('../startup/main-process-state', () => ({ mainProcessState: mocks.state }))
vi.mock('../startup/main-window-service-readiness', () => ({
  requireMainWindowServices: () => ({ store: mocks.store, keybindings: mocks.state.keybindings })
}))
vi.mock('../startup/windows-user-data-acl', () => ({ ensureWindowsUserDataAclGrant: vi.fn() }))
vi.mock('../startup/windows-install-dir-acl-probe', () => ({
  probeWindowsInstallDirAcl: vi.fn(() => false)
}))
vi.mock('../startup/windows-install-dir-acl-recovery', () => ({
  noteWindowsInstallDirAclProbePending: vi.fn(),
  startWindowsInstallDirAclRepairIfPoisoned: vi.fn()
}))
vi.mock('../crash-reporting/crash-breadcrumb-store', () => ({
  recordCrashBreadcrumb: vi.fn(),
  recordCoalescedCrashBreadcrumb: vi.fn()
}))
vi.mock('../crash-reporting/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: vi.fn()
}))
vi.mock('../crash-reporting/process-gone-classification', () => ({
  shouldRecoverRendererAfterProcessGone: vi.fn(() => true)
}))
vi.mock('../telemetry/consent', () => ({
  resolveConsent: vi.fn(() => ({ effective: 'disabled' }))
}))
vi.mock('../telemetry/client', () => ({ trackAppOpenedOnce: vi.fn() }))
vi.mock('../window/main-window-visibility', () => ({ notifyMainWindowBecameVisible: vi.fn() }))
vi.mock('../tray/system-tray', () => ({ setTrayAttention: vi.fn() }))
vi.mock('../startup/main-window-actions', () => ({
  createSystemTrayDeferred: vi.fn(() => vi.fn()),
  getSystemTrayOptions: vi.fn(),
  showMainWindowFromTray: vi.fn(),
  showRendererRecoveryPrompt: vi.fn(),
  syncMacMenuBarIcon: vi.fn()
}))
vi.mock('../startup/main-window-agent-status', () => ({
  clearMainWindowAgentStatusListeners: vi.fn(),
  installMainWindowAgentStatusListeners: vi.fn()
}))
vi.mock('../startup/main-window-lifecycle-flags', () => ({
  clearExpectedRendererReload: vi.fn(),
  getExpectedTeardownScope: vi.fn(),
  markExpectedRendererReload: vi.fn(),
  markRecoveryReloadInFlight: vi.fn(),
  recordProcessGoneCrash: vi.fn()
}))
vi.mock('../startup/gpu-lifecycle', () => ({ presentGpuFallbackRecoveredLaunchPrompt: vi.fn() }))
vi.mock('../startup/branch-rename-hook', () => ({
  maybeAutoRenameBranchOnFirstWorkFromHook: vi.fn()
}))
vi.mock('../startup/synthetic-title-runtime', () => ({
  resumeSyntheticTitleSpinnerTimer: vi.fn(),
  stopSyntheticTitleSpinnerTimer: vi.fn()
}))

import { openMainWindow, restoreWorkspaceWindows } from '../startup/main-window-controller'

describe('workspace window lifecycle', () => {
  it('preserves the native Orca identity when the web entry publishes its page title', () => {
    openMainWindow({ kind: 'workspace' })
    const window = mocks.windows[0]!
    expect(window.options.title).toBe('Orca')
    const preventDefault = vi.fn()
    window.emit('page-title-updated', { preventDefault }, 'Orca Web')
    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('reopens a normally closed window using its stable partition and fresh authorization', () => {
    const first = openMainWindow({ kind: 'workspace' })
    const id = (mocks.ui.workspaceWindowIds as string[])[0]
    mocks.windows[0].emit('closed')
    expect(mocks.ui.workspaceWindowIds).toEqual([])
    const reopened = openMainWindow({ kind: 'workspace', reopen: true })
    expect(reopened).not.toBe(first)
    expect(mocks.windows[1].options.webPreferences?.partition).toBe(
      `persist:orca-workspace-window-${id}`
    )
    expect(mocks.ui.workspaceWindowIds).toEqual([id])
    expect(mocks.state.runtimeRpc.createPairingOffer).toHaveBeenCalledTimes(2)
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.windows.length = 0
    for (const key of Object.keys(mocks.ui)) {
      delete mocks.ui[key]
    }
    mocks.state.isQuitting = false
    mocks.state.mainWindow = new mocks.FakeWindow()
    mocks.windows.length = 0
    mocks.createMainWindow.mockImplementation(() => new mocks.FakeWindow())
  })

  it('creates independently identified project windows without reattaching singleton services', () => {
    const first = openMainWindow({ kind: 'workspace' } as never)
    const second = openMainWindow({ kind: 'workspace' } as never)

    expect(mocks.createMainWindow).not.toHaveBeenCalled()
    expect(mocks.attachCore).not.toHaveBeenCalled()
    expect(first).not.toBe(second)
    expect(mocks.state.mainWindow).not.toBe(first)
    expect(mocks.state.runtimeRpc.createPairingOffer).toHaveBeenCalledTimes(2)
    expect(mocks.state.runtimeRpc.createPairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        address: '127.0.0.1',
        reach: 'this-computer',
        reuseDeviceName: true
      })
    )

    const [firstUrl] = mocks.windows[0]!.loadURL.mock.calls[0]!
    const [secondUrl] = mocks.windows[1]!.loadURL.mock.calls[0]!
    const firstId = new URL(firstUrl).searchParams.get('workspaceWindowId')
    const secondId = new URL(secondUrl).searchParams.get('workspaceWindowId')
    expect(firstId).toBeTruthy()
    expect(secondId).toBeTruthy()
    expect(firstId).not.toBe(secondId)
    expect(mocks.windows[0]!.options.webPreferences?.partition).not.toBe(
      mocks.windows[1]!.options.webPreferences?.partition
    )
    expect(mocks.windows[0]!.options.webPreferences?.preload).toMatch(
      /workspace-window-preload\.js$/
    )
  })

  it('closing a secondary window leaves the primary runtime and other windows alive', () => {
    const primary = mocks.state.mainWindow
    const first = openMainWindow({ kind: 'workspace' } as never) as unknown as InstanceType<
      typeof mocks.FakeWindow
    >
    const second = openMainWindow({ kind: 'workspace' } as never) as unknown as InstanceType<
      typeof mocks.FakeWindow
    >

    first.destroyed = true
    first.emit('closed')

    expect(mocks.state.mainWindow).toBe(primary)
    expect(mocks.state.runtime).toBeTruthy()
    expect(second.isDestroyed()).toBe(false)
    expect(mocks.state.runtimeRpc.revokeRuntimeAccess).toHaveBeenCalledWith('device-1')
  })

  it('routes native close through the web client confirmation flow', () => {
    openMainWindow({ kind: 'workspace' } as never)
    const preventDefault = vi.fn()

    mocks.windows[0]!.emit('close', { preventDefault })

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(mocks.windows[0]!.webContents.send).toHaveBeenCalledWith(
      'workspaceWindow:closeRequested',
      { isQuitting: false, requestId: 1 }
    )
  })

  it('flushes the latest placement before a pending move timer can be lost on close', () => {
    const window = openMainWindow({
      kind: 'workspace',
      windowId: 'close-race'
    } as never) as unknown as InstanceType<typeof mocks.FakeWindow>
    window.emit('move')
    window.emit('close', { preventDefault: vi.fn() })
    window.destroyed = true
    window.emit('closed')
    expect(mocks.ui.workspaceWindowPlacements).toMatchObject({
      'close-race': { bounds: { x: 20, y: 30, width: 1000, height: 700 }, maximized: false }
    })
  })

  it('keeps secondary save and discard guards in the application quit path', () => {
    openMainWindow({ kind: 'workspace' } as never)
    mocks.state.isQuitting = true
    const preventDefault = vi.fn()
    mocks.windows[0]!.emit('close', { preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(mocks.windows[0]!.webContents.send).toHaveBeenCalledWith(
      'workspaceWindow:closeRequested',
      { isQuitting: true, requestId: 1 }
    )
  })

  it('restores placement by stable window identity without borrowing another window bounds', () => {
    Object.assign(mocks.ui, {
      workspaceWindowIds: ['saved-window'],
      workspaceWindowPlacements: {
        'saved-window': {
          bounds: { x: 140, y: 160, width: 900, height: 700 },
          maximized: false
        }
      }
    })

    openMainWindow({ kind: 'workspace', windowId: 'saved-window' } as never)
    openMainWindow({ kind: 'workspace', windowId: 'new-window' } as never)

    expect(mocks.windows[0]!.options).toMatchObject({
      x: 140,
      y: 160,
      width: 900,
      height: 700,
      webPreferences: { partition: 'persist:orca-workspace-window-saved-window' }
    })
    expect(mocks.windows[1]!.options.x).toBeUndefined()
    expect(mocks.windows[1]!.options.y).toBeUndefined()
    expect(mocks.ui.workspaceWindowIds).toEqual(['saved-window', 'new-window'])
  })

  it('reopens persisted secondary windows after the shared runtime starts', () => {
    Object.assign(mocks.ui, { workspaceWindowIds: ['window-a', 'window-b'] })

    restoreWorkspaceWindows()

    expect(mocks.windows).toHaveLength(2)
    expect(mocks.windows.map((window) => window.options.webPreferences?.partition)).toEqual([
      'persist:orca-workspace-window-window-a',
      'persist:orca-workspace-window-window-b'
    ])
  })

  it('does not maximize a restored window during a background launch', () => {
    Object.assign(mocks.ui, {
      workspaceWindowPlacements: {
        'saved-window': {
          bounds: { x: 140, y: 160, width: 900, height: 700 },
          maximized: true
        }
      }
    })

    openMainWindow({ kind: 'workspace', windowId: 'saved-window' } as never)
    const window = mocks.windows[0]!
    window.events.get('ready-to-show')?.[0]?.()

    expect(window.maximize).not.toHaveBeenCalled()
  })
})
