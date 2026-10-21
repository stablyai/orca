import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { UpdaterSetupOptions } from '../updater'

const { setupMock, milestoneMock } = vi.hoisted(() => ({
  setupMock: vi.fn<(window: BrowserWindow, options?: UpdaterSetupOptions) => void>(),
  milestoneMock: vi.fn<(name: string) => void>()
}))

vi.mock('electron', () => ({ app: {}, ipcMain: {} }))
vi.mock('../updater', () => ({ setupAutoUpdater: setupMock }))
vi.mock('../ipc/ui', () => ({ isTrustedUIRenderer: () => true }))
vi.mock('../startup/startup-diagnostics', () => ({ logStartupMilestone: milestoneMock }))

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

function capturedSetupOptions(): UpdaterSetupOptions {
  const options = setupMock.mock.calls.at(-1)?.[1]
  if (!options) {
    throw new Error('Missing updater options')
  }
  return options
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

  it('releases all 64 completed fallback handles without repeating initialization', async () => {
    const updater = await import('./main-window-updater')
    for (let index = 0; index < 64; index++) {
      const owner = createWindowOwner()
      updater.scheduleMainWindowAutoUpdaterSetup(owner.mainWindow, owner.persistence)
      expect(vi.getTimerCount()).toBe(1)
      updater.ensureAutoUpdaterConfigured()
      expect(setupMock).toHaveBeenLastCalledWith(owner.mainWindow, expect.any(Object))
      expect(milestoneMock).toHaveBeenLastCalledWith('updater-setup-done')
      expect(vi.getTimerCount()).toBe(0)
    }
    updater.ensureAutoUpdaterConfigured()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(setupMock).toHaveBeenCalledTimes(64)
    expect(milestoneMock).toHaveBeenCalledTimes(64)
    expect(vi.getTimerCount()).toBe(0)
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

  it('keeps setup after ready-to-show and releases its fallback afterward', async () => {
    const updater = await import('./main-window-updater')
    const owner = createWindowOwner()
    updater.scheduleMainWindowAutoUpdaterSetup(owner.mainWindow, owner.persistence)
    owner.window.emit('ready-to-show')
    expect(setupMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(setupMock).toHaveBeenCalledOnce()
    expect(milestoneMock).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    owner.window.emit('ready-to-show')
    updater.ensureAutoUpdaterConfigured()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(setupMock).toHaveBeenCalledOnce()
  })

  it('preserves the 15-second fallback when first paint never arrives', async () => {
    const updater = await import('./main-window-updater')
    const owner = createWindowOwner()
    updater.scheduleMainWindowAutoUpdaterSetup(owner.mainWindow, owner.persistence)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(setupMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(setupMock).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    owner.window.emit('ready-to-show')
    await vi.advanceTimersByTimeAsync(0)
    expect(setupMock).toHaveBeenCalledOnce()
  })

  it('preserves destroyed-window guard reads before and at the fallback deadline', async () => {
    const updater = await import('./main-window-updater')
    const owner = createWindowOwner()
    updater.scheduleMainWindowAutoUpdaterSetup(owner.mainWindow, owner.persistence)
    owner.window.isDestroyed.mockReturnValue(true)
    updater.ensureAutoUpdaterConfigured()
    expect(owner.window.isDestroyed).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(owner.window.isDestroyed).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(owner.window.isDestroyed).toHaveBeenCalledTimes(2)
    updater.ensureAutoUpdaterConfigured()
    expect(owner.window.isDestroyed).toHaveBeenCalledTimes(3)
    expect(setupMock).not.toHaveBeenCalled()
  })

  it('keeps the fallback guard when destruction happens after ready but before immediate', async () => {
    const updater = await import('./main-window-updater')
    const owner = createWindowOwner()
    updater.scheduleMainWindowAutoUpdaterSetup(owner.mainWindow, owner.persistence)
    owner.window.emit('ready-to-show')
    owner.window.isDestroyed.mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(owner.window.isDestroyed).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(owner.window.isDestroyed).toHaveBeenCalledTimes(2)
    expect(setupMock).not.toHaveBeenCalled()
  })

  it('retains original setup order and avoids reentrant initialization', async () => {
    const updater = await import('./main-window-updater')
    const owner = createWindowOwner()
    const trace: string[] = []
    setupMock.mockImplementation(() => {
      trace.push('setup')
      updater.ensureAutoUpdaterConfigured()
      trace.push('setup-return')
    })
    milestoneMock.mockImplementation(() => {
      trace.push('milestone')
      updater.ensureAutoUpdaterConfigured()
    })
    updater.scheduleMainWindowAutoUpdaterSetup(owner.mainWindow, owner.persistence)
    updater.ensureAutoUpdaterConfigured()
    expect(trace).toEqual(['setup', 'setup-return', 'milestone'])
    expect(setupMock).toHaveBeenCalledOnce()
    expect(owner.window.isDestroyed).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['setup', 'milestone'] as const)(
    'keeps the exact %s error and releases its completed fallback',
    async (failure) => {
      const updater = await import('./main-window-updater')
      const owner = createWindowOwner()
      const error = new Error(`${failure} failed`)
      if (failure === 'setup') {
        setupMock.mockImplementation(() => {
          throw error
        })
      } else {
        milestoneMock.mockImplementation(() => {
          throw error
        })
      }
      updater.scheduleMainWindowAutoUpdaterSetup(owner.mainWindow, owner.persistence)
      expect(captureError(() => updater.ensureAutoUpdaterConfigured())).toBe(error)
      expect(setupMock).toHaveBeenCalledOnce()
      expect(milestoneMock).toHaveBeenCalledTimes(failure === 'setup' ? 0 : 1)
      expect(vi.getTimerCount()).toBe(0)
      updater.ensureAutoUpdaterConfigured()
      await vi.advanceTimersByTimeAsync(15_000)
      expect(setupMock).toHaveBeenCalledOnce()
    }
  )

  it.each(['setup', 'milestone'] as const)(
    'keeps the exact fallback %s error without retrying initialization',
    async (failure) => {
      const updater = await import('./main-window-updater')
      const owner = createWindowOwner()
      const error = new Error(`${failure} fallback failed`)
      if (failure === 'setup') {
        setupMock.mockImplementation(() => {
          throw error
        })
      } else {
        milestoneMock.mockImplementation(() => {
          throw error
        })
      }
      updater.scheduleMainWindowAutoUpdaterSetup(owner.mainWindow, owner.persistence)
      await expect(vi.advanceTimersByTimeAsync(15_000)).rejects.toBe(error)
      updater.ensureAutoUpdaterConfigured()
      expect(setupMock).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

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

  it('preserves pending manual setup after failed ready registration', async () => {
    const updater = await import('./main-window-updater')
    const owner = createWindowOwner()
    const error = new Error('ready registration failed')
    vi.spyOn(owner.window, 'once').mockImplementationOnce(() => {
      throw error
    })
    expect(
      captureError(() =>
        updater.scheduleMainWindowAutoUpdaterSetup(owner.mainWindow, owner.persistence)
      )
    ).toBe(error)
    expect(vi.getTimerCount()).toBe(0)
    updater.ensureAutoUpdaterConfigured()
    expect(setupMock).toHaveBeenCalledOnce()
  })

  it('releases the fallback created after synchronous registration reentry', async () => {
    const updater = await import('./main-window-updater')
    const owner = createWindowOwner()
    const once = owner.window.once.bind(owner.window)
    vi.spyOn(owner.window, 'once').mockImplementationOnce((event, listener) => {
      updater.ensureAutoUpdaterConfigured()
      return once(event, listener)
    })
    updater.scheduleMainWindowAutoUpdaterSetup(owner.mainWindow, owner.persistence)
    expect(setupMock).toHaveBeenCalledOnce()
    expect(milestoneMock).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    owner.window.emit('ready-to-show')
    await vi.advanceTimersByTimeAsync(0)
    expect(setupMock).toHaveBeenCalledOnce()
  })

  it('keeps a same-ID successor pending after the old window becomes ready', async () => {
    const updater = await import('./main-window-updater')
    const old = createWindowOwner()
    const successor = createWindowOwner()
    updater.scheduleMainWindowAutoUpdaterSetup(old.mainWindow, old.persistence)
    updater.scheduleMainWindowAutoUpdaterSetup(successor.mainWindow, successor.persistence)
    expect(vi.getTimerCount()).toBe(2)
    old.window.emit('ready-to-show')
    await vi.advanceTimersByTimeAsync(0)
    expect(setupMock).toHaveBeenLastCalledWith(old.mainWindow, expect.any(Object))
    expect(vi.getTimerCount()).toBe(1)
    updater.ensureAutoUpdaterConfigured()
    expect(setupMock).toHaveBeenLastCalledWith(successor.mainWindow, expect.any(Object))
    expect(setupMock).toHaveBeenCalledTimes(2)
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

  it('preserves the successor after an old destroyed fallback', async () => {
    const updater = await import('./main-window-updater')
    const old = createWindowOwner()
    const successor = createWindowOwner()
    updater.scheduleMainWindowAutoUpdaterSetup(old.mainWindow, old.persistence)
    old.window.isDestroyed.mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(5_000)
    updater.scheduleMainWindowAutoUpdaterSetup(successor.mainWindow, successor.persistence)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(setupMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    updater.ensureAutoUpdaterConfigured()
    expect(setupMock).toHaveBeenCalledWith(successor.mainWindow, expect.any(Object))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps setup options, live store reads, nudge writes and required quit flush', async () => {
    const updater = await import('./main-window-updater')
    const owner = createWindowOwner()
    const trace: string[] = []
    const error = new Error('required cleanup failed')
    owner.store.flushPendingAsync.mockImplementation(async () => {
      trace.push('flush')
    })
    updater.scheduleMainWindowAutoUpdaterSetup(owner.mainWindow, owner.persistence, {
      updateInstallMode: 'supervised-headless-serve',
      onBeforeUpdateQuitFailure: 'abort',
      onBeforeUpdateQuit: () => {
        trace.push('cleanup')
        throw error
      }
    })
    updater.ensureAutoUpdaterConfigured()
    const options = capturedSetupOptions()
    expect(Object.keys(options)).toEqual([
      'getLastUpdateCheckAt',
      'onBeforeQuit',
      'setLastUpdateCheckAt',
      'getPendingUpdateNudgeId',
      'getDismissedUpdateNudgeId',
      'setPendingUpdateNudgeId',
      'setDismissedUpdateNudgeId',
      'getReleaseChannelOverride',
      'onBeforeQuitFailure',
      'installMode'
    ])
    expect(options.getLastUpdateCheckAt?.()).toBe(123)
    expect(options.getPendingUpdateNudgeId?.()).toBe('pending')
    expect(options.getDismissedUpdateNudgeId?.()).toBe('dismissed')
    expect(options.getReleaseChannelOverride?.()).toBe('rc')
    owner.store.getUI.mockReturnValue({ ...owner.store.getUI(), lastUpdateCheckAt: 456 })
    expect(options.getLastUpdateCheckAt?.()).toBe(456)
    options.setLastUpdateCheckAt?.(789)
    options.setPendingUpdateNudgeId?.('next')
    options.setPendingUpdateNudgeId?.(null)
    options.setDismissedUpdateNudgeId?.('dismiss')
    expect(owner.store.updateUI.mock.calls).toEqual([
      [{ lastUpdateCheckAt: 789 }],
      [{ pendingUpdateNudgeId: 'next', dismissedUpdateVersion: null }],
      [{ pendingUpdateNudgeId: null }],
      [{ dismissedUpdateNudgeId: 'dismiss' }]
    ])
    expect(options.installMode).toBe('supervised-headless-serve')
    expect(options.onBeforeQuitFailure).toBe('abort')
    await expect(options.onBeforeQuit?.()).rejects.toBe(error)
    expect(trace).toEqual(['cleanup', 'flush'])
    expect(vi.getTimerCount()).toBe(0)
  })
})
