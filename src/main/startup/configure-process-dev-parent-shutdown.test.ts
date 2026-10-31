import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerServeSignalHandlers } from './serve-signal-handlers'

const { closeServers, forceCloseServers, readyListeners } = vi.hoisted(() => ({
  closeServers: vi.fn(async () => {}),
  forceCloseServers: vi.fn(async () => {}),
  readyListeners: new Array<() => void>()
}))
vi.mock('./serve-signal-handlers', () => ({ registerServeSignalHandlers: vi.fn() }))

vi.mock('electron', () => ({
  app: {
    quit: vi.fn(),
    exit: vi.fn(),
    isPackaged: false,
    isReady: vi.fn(() => false),
    once: vi.fn((event: string, listener: () => void) => {
      if (event === 'ready') {
        readyListeners.push(listener)
      }
    })
  }
}))

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  readyListeners.splice(0)
})

describe('installDevParentDisconnectQuit', () => {
  it('quits the dev app when the supervising IPC channel disconnects', async () => {
    const { app } = await import('electron')
    const {
      installDevParentDisconnectQuit,
      isDevParentShutdownRequested,
      resetDevParentShutdownRequestForTests
    } = await import('./configure-process')

    vi.useFakeTimers()
    resetDevParentShutdownRequestForTests()
    const originalSend = process.send
    const originalOnce = process.once.bind(process)
    const disconnectHandlers: (() => void)[] = []

    process.send = (() => true) as unknown as NodeJS.Process['send']
    process.once = ((event: string | symbol, listener: (...args: any[]) => void) => {
      if (event === 'disconnect') {
        disconnectHandlers.push(listener as () => void)
      }
      return process
    }) as NodeJS.Process['once']

    vi.mocked(app.quit).mockClear()

    try {
      installDevParentDisconnectQuit(true)
    } finally {
      process.send = originalSend
      process.once = originalOnce
    }

    expect(disconnectHandlers).toHaveLength(1)
    expect(isDevParentShutdownRequested()).toBe(false)
    disconnectHandlers[0]()
    expect(isDevParentShutdownRequested()).toBe(true)
    expect(app.quit).toHaveBeenCalledTimes(1)
    expect(app.exit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(3000)
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('does not register the disconnect hook outside dev ipc launches', async () => {
    const { installDevParentDisconnectQuit } = await import('./configure-process')
    const originalSend = process.send
    const originalOnce = process.once.bind(process)
    const onceSpy = vi.fn(originalOnce)

    process.send = undefined
    process.once = onceSpy as NodeJS.Process['once']

    try {
      installDevParentDisconnectQuit(true)
      installDevParentDisconnectQuit(false)
    } finally {
      process.send = originalSend
      process.once = originalOnce
    }

    expect(onceSpy).not.toHaveBeenCalledWith('disconnect', expect.any(Function))
  })
})

describe('installDevParentWatchdog', () => {
  it('quits the dev app when the original parent pid disappears', async () => {
    const { app } = await import('electron')
    const {
      installDevParentWatchdog,
      isDevParentShutdownRequested,
      resetDevParentShutdownRequestForTests
    } = await import('./configure-process')

    vi.useFakeTimers()
    resetDevParentShutdownRequestForTests()
    vi.mocked(app.quit).mockClear()
    vi.mocked(app.exit).mockClear()

    let parentExists = true
    vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number
    ) => {
      if (signal === 0 && pid === 4242 && !parentExists) {
        const error = new Error('missing') as NodeJS.ErrnoException
        error.code = 'ESRCH'
        throw error
      }
      return true
    }) as typeof process.kill)

    const originalPpid = Object.getOwnPropertyDescriptor(process, 'ppid')
    Object.defineProperty(process, 'ppid', {
      configurable: true,
      get: () => 4242
    })

    try {
      installDevParentWatchdog(true)
      await vi.advanceTimersByTimeAsync(1000)
      expect(app.quit).not.toHaveBeenCalled()

      parentExists = false
      await vi.advanceTimersByTimeAsync(1000)
      expect(isDevParentShutdownRequested()).toBe(true)
      expect(app.quit).toHaveBeenCalledTimes(1)
      expect(app.exit).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(3000)
      expect(app.exit).toHaveBeenCalledWith(0)
    } finally {
      if (originalPpid) {
        Object.defineProperty(process, 'ppid', originalPpid)
      }
    }
  })

  it('does not start the watchdog outside dev mode', async () => {
    const { installDevParentWatchdog } = await import('./configure-process')
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')

    installDevParentWatchdog(false)

    expect(setIntervalSpy).not.toHaveBeenCalled()
  })
})

describe('installDevParentSignalQuit', () => {
  it('rearms persistent signal handlers after Electron ready and starts cleanup once', async () => {
    const { app } = await import('electron')
    const {
      installDevParentSignalQuit,
      isDevParentShutdownRequested,
      resetDevParentShutdownRequestForTests
    } = await import('./configure-process')
    vi.useFakeTimers()
    resetDevParentShutdownRequestForTests()
    installDevParentSignalQuit(true, () => ({ close: closeServers, forceClose: forceCloseServers }))
    expect(registerServeSignalHandlers).toHaveBeenCalledTimes(1)
    expect(registerServeSignalHandlers).toHaveBeenCalledWith(process, expect.any(Function), [
      'SIGINT',
      'SIGTERM'
    ])
    expect(readyListeners).toHaveLength(1)
    readyListeners[0]?.()
    expect(registerServeSignalHandlers).toHaveBeenCalledTimes(2)
    const shutdown = vi.mocked(registerServeSignalHandlers).mock.calls[0]?.[1]
    expect(shutdown).toBeTypeOf('function')
    shutdown?.()
    shutdown?.()
    expect(isDevParentShutdownRequested()).toBe(true)
    expect(closeServers).toHaveBeenCalledOnce()
    expect(app.quit).toHaveBeenCalledOnce()
    expect(app.exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3000)
    expect(forceCloseServers).toHaveBeenCalledOnce()
    expect(app.exit).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('waits for owned process termination before the forced exit even if normal quit stalls', async () => {
    const { app } = await import('electron')
    const { installDevParentSignalQuit, resetDevParentShutdownRequestForTests } =
      await import('./configure-process')
    vi.useFakeTimers()
    resetDevParentShutdownRequestForTests()
    let release = () => {}
    forceCloseServers.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    installDevParentSignalQuit(true, () => ({ close: closeServers, forceClose: forceCloseServers }))
    vi.mocked(registerServeSignalHandlers).mock.calls[0]?.[1]()
    await vi.advanceTimersByTimeAsync(3000)
    expect(forceCloseServers).toHaveBeenCalledOnce()
    expect(app.exit).not.toHaveBeenCalled()
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('registers immediately without waiting for a ready event that already happened', async () => {
    const { app } = await import('electron')
    const { installDevParentSignalQuit } = await import('./configure-process')
    vi.mocked(app.isReady).mockReturnValueOnce(true)
    installDevParentSignalQuit(true, () => ({ close: closeServers, forceClose: forceCloseServers }))
    expect(registerServeSignalHandlers).toHaveBeenCalledOnce()
    expect(readyListeners).toHaveLength(0)
  })

  it('does not register signal handlers outside supervised dev runs', async () => {
    const { installDevParentSignalQuit } = await import('./configure-process')
    installDevParentSignalQuit(false)
    expect(registerServeSignalHandlers).not.toHaveBeenCalled()
    expect(readyListeners).toHaveLength(0)
  })
})
