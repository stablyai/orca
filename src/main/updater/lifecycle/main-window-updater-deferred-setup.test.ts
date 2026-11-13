import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../../persistence/loading-store/store'
import type { UpdaterSetupOptions } from './updater-setup'

const { setupMock, milestoneMock, getMainWindowMock } = vi.hoisted(() => ({
  getMainWindowMock: vi.fn<() => BrowserWindow | null>(() => null),
  setupMock: vi.fn<(window: BrowserWindow, options?: UpdaterSetupOptions) => void>(),
  milestoneMock: vi.fn<(name: string) => void>()
}))

vi.mock('electron', () => ({ app: {}, ipcMain: {} }))
vi.mock('../updater-service', () => ({ setupAutoUpdater: setupMock }))
vi.mock('./electron-updater-proxy-session', () => ({
  applyProxyToElectronUpdaterSession: vi.fn()
}))
vi.mock('../../ipc/ui', () => ({
  isTrustedUIRenderer: () => true,
  getTrustedUIRendererWindow: getMainWindowMock
}))
vi.mock('../../startup/diagnostics/startup-diagnostics', () => ({
  logStartupMilestone: milestoneMock
}))

function createWindowOwner() {
  const window = Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: vi.fn(() => false)
  })
  const ui = {
    lastUpdateCheckAt: 123,
    pendingUpdateNudgeId: 'pending',
    dismissedUpdateNudgeId: 'dismissed',
    releaseChannelOverride: 'rc'
  } satisfies Partial<ReturnType<Store['getUI']>>
  const store = {
    getSettings: vi.fn(() => ({})),
    getUI: vi.fn(() => ui),
    updateUI: vi.fn<(patch: Parameters<Store['updateUI']>[0]) => void>(),
    flushPendingAsync: vi.fn<Store['flushPendingAsync']>().mockResolvedValue(undefined)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This owner only reads id/isDestroyed and registers once; EventEmitter supplies the original once contract.
  const mainWindow = window as unknown as BrowserWindow
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The complete owner accesses only these three store methods and the checked UI fields above.
  const persistence = store as unknown as Store
  return { window, mainWindow, store, persistence }
}

function captureError(action: () => void): unknown {
  try {
    action()
  } catch (error) {
    return error
  }
  throw new Error('Expected action to throw')
}

describe('completed deferred updater setup ownership', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    setupMock.mockReset()
    milestoneMock.mockReset()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not retain the expired native fallback of a destroyed window', async () => {
    vi.useRealTimers()
    const updater = await import('./main-window-updater')
    const owner = createWindowOwner()
    owner.window.isDestroyed.mockReturnValue(true)
    function scheduleNativeFallback(): WeakRef<NodeJS.Timeout> {
      const nativeSetTimeout = globalThis.setTimeout
      const armed = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation((callback, delay, ...args) =>
          nativeSetTimeout(callback, delay === 15_000 ? 1 : delay, ...args)
        )
      try {
        updater.scheduleMainWindowAutoUpdaterSetup(owner.mainWindow, owner.persistence)
        expect(armed).toHaveBeenCalledOnce()
        expect(armed.mock.calls[0]?.[1]).toBe(15_000)
        const handle = armed.mock.results[0]?.value
        if (!handle) {
          throw new Error('Missing native fallback timer')
        }
        expect(handle.hasRef()).toBe(false)
        return new WeakRef(handle)
      } finally {
        armed.mockClear()
        armed.mockRestore()
      }
    }
    // The real deadline has separate paired proof; only this fixture's native wait is shortened.
    const weakTimer = scheduleNativeFallback()
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    expect(owner.window.isDestroyed).toHaveBeenCalledOnce()
    updater.ensureAutoUpdaterConfigured()
    expect(owner.window.isDestroyed).toHaveBeenCalledTimes(2)
    expect(setupMock).not.toHaveBeenCalled()
    expect(milestoneMock).not.toHaveBeenCalled()
    expect(globalThis.gc).toBeTypeOf('function')
    for (let turn = 0; turn < 4; turn++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      globalThis.gc?.()
    }
    expect(weakTimer.deref()).toBeUndefined()
  })

  it('preserves pending retry after a failed destroyed-state read', async () => {
    const updater = await import('./main-window-updater')
    const owner = createWindowOwner()
    const error = new Error('destroyed-state read failed')
    owner.window.isDestroyed.mockImplementationOnce(() => {
      throw error
    })
    updater.scheduleMainWindowAutoUpdaterSetup(owner.mainWindow, owner.persistence)
    expect(captureError(() => updater.ensureAutoUpdaterConfigured())).toBe(error)
    expect(setupMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    updater.ensureAutoUpdaterConfigured()
    expect(setupMock).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['setup', 'milestone'] as const)(
    'preserves a reentrant successor when the old %s throws',
    async (failure) => {
      const updater = await import('./main-window-updater')
      const old = createWindowOwner()
      const successor = createWindowOwner()
      const error = new Error('old owner failed after replacement')
      const replaceAndThrow = () => {
        updater.scheduleMainWindowAutoUpdaterSetup(successor.mainWindow, successor.persistence)
        throw error
      }
      if (failure === 'setup') {
        setupMock.mockImplementationOnce(replaceAndThrow)
      } else {
        milestoneMock.mockImplementationOnce(replaceAndThrow)
      }
      updater.scheduleMainWindowAutoUpdaterSetup(old.mainWindow, old.persistence)
      expect(captureError(() => updater.ensureAutoUpdaterConfigured())).toBe(error)
      expect(vi.getTimerCount()).toBe(1)
      updater.ensureAutoUpdaterConfigured()
      expect(setupMock).toHaveBeenLastCalledWith(successor.mainWindow, expect.any(Object))
      expect(setupMock).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})
