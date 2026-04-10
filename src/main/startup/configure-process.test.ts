import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const paths = new Map<string, string>([['appData', '/tmp/app-data']])
  return {
    app: {
      getPath: vi.fn((name: string) => paths.get(name) ?? ''),
      setPath: vi.fn((name: string, value: string) => {
        paths.set(name, value)
      }),
      quit: vi.fn(),
      commandLine: {
        appendSwitch: vi.fn()
      }
    }
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('configureDevUserDataPath', () => {
  it('moves dev runs onto an orca-dev userData path', async () => {
    const { app } = await import('electron')
    const { configureDevUserDataPath } = await import('./configure-process')

    configureDevUserDataPath(true)

    // Why: production code uses path.join(app.getPath('appData'), 'orca-dev')
    // which produces platform-specific separators.
    expect(app.setPath).toHaveBeenCalledWith('userData', join('/tmp/app-data', 'orca-dev'))
  })

  it('leaves packaged runs on the default userData path', async () => {
    const { app } = await import('electron')
    const { configureDevUserDataPath } = await import('./configure-process')

    vi.mocked(app.setPath).mockClear()
    configureDevUserDataPath(false)

    expect(app.setPath).not.toHaveBeenCalled()
  })
})

describe('installDevParentDisconnectQuit', () => {
  it('quits the dev app when the supervising IPC channel disconnects', async () => {
    const { app } = await import('electron')
    const { installDevParentDisconnectQuit } = await import('./configure-process')

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
    disconnectHandlers[0]()
    expect(app.quit).toHaveBeenCalledTimes(1)
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
    const { installDevParentWatchdog } = await import('./configure-process')

    vi.useFakeTimers()
    vi.mocked(app.quit).mockClear()

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
      expect(app.quit).toHaveBeenCalledTimes(1)
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
