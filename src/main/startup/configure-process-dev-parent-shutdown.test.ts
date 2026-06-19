import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    quit: vi.fn(),
    exit: vi.fn(),
    isPackaged: false
  }
}))

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
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
  it('quits the dev app when the supervisor forwards a terminal signal', async () => {
    const { app } = await import('electron')
    const {
      installDevParentSignalQuit,
      isDevParentShutdownRequested,
      resetDevParentShutdownRequestForTests
    } = await import('./configure-process')

    vi.useFakeTimers()
    resetDevParentShutdownRequestForTests()
    const originalOnce = process.once.bind(process)
    const signalHandlers = new Map<string | symbol, () => void>()

    process.once = ((event: string | symbol, listener: (...args: any[]) => void) => {
      signalHandlers.set(event, listener as () => void)
      return process
    }) as NodeJS.Process['once']

    vi.mocked(app.quit).mockClear()
    vi.mocked(app.exit).mockClear()

    try {
      installDevParentSignalQuit(true)
    } finally {
      process.once = originalOnce
    }

    expect(signalHandlers.has('SIGINT')).toBe(true)
    expect(signalHandlers.has('SIGTERM')).toBe(true)
    expect(isDevParentShutdownRequested()).toBe(false)

    signalHandlers.get('SIGTERM')?.()

    expect(isDevParentShutdownRequested()).toBe(true)
    expect(app.quit).toHaveBeenCalledTimes(1)
    expect(app.exit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(3000)
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('does not register signal handlers outside supervised dev runs', async () => {
    const { installDevParentSignalQuit } = await import('./configure-process')
    const originalOnce = process.once.bind(process)
    const onceSpy = vi.fn(originalOnce)

    process.once = onceSpy as NodeJS.Process['once']

    try {
      installDevParentSignalQuit(false)
    } finally {
      process.once = originalOnce
    }

    expect(onceSpy).not.toHaveBeenCalledWith('SIGINT', expect.any(Function))
    expect(onceSpy).not.toHaveBeenCalledWith('SIGTERM', expect.any(Function))
  })
})
