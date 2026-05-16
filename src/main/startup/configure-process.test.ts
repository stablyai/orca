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
      exit: vi.fn(),
      isPackaged: false,
      disableHardwareAcceleration: vi.fn(),
      commandLine: {
        appendSwitch: vi.fn(),
        getSwitchValue: vi.fn(() => '')
      }
    }
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('patchPackagedProcessPath', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const originalHome = process.env.HOME
  const originalPath = process.env.PATH

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: platform
    })
  }

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
  })

  it('prepends agent-CLI install dirs (~/.opencode/bin, ~/.vite-plus/bin) for packaged darwin runs', async () => {
    const { app } = await import('electron')
    const { patchPackagedProcessPath } = await import('./configure-process')

    setPlatform('darwin')
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
    process.env.HOME = '/Users/tester'
    process.env.PATH = '/usr/bin:/bin'

    patchPackagedProcessPath()

    const segments = (process.env.PATH ?? '').split(':')
    // Why: issue #829 — ~/.opencode/bin and ~/.vite-plus/bin are the documented
    // fallback install locations for the opencode and Pi CLI install scripts.
    // Without them on PATH, GUI-launched Orca reports both as "Not installed"
    // even when `which` resolves them in the user's shell.
    expect(segments).toContain('/Users/tester/.opencode/bin')
    expect(segments).toContain('/Users/tester/.vite-plus/bin')
    expect(segments).toContain('/Users/tester/bin')
  })

  it('leaves PATH untouched when the app is not packaged', async () => {
    const { app } = await import('electron')
    const { patchPackagedProcessPath } = await import('./configure-process')

    setPlatform('darwin')
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: false })
    process.env.HOME = '/Users/tester'
    process.env.PATH = '/usr/bin:/bin'

    patchPackagedProcessPath()

    expect(process.env.PATH).toBe('/usr/bin:/bin')
  })
})

describe('configureDevUserDataPath', () => {
  it('uses an explicit dev userData override when provided', async () => {
    const { app } = await import('electron')
    const { configureDevUserDataPath } = await import('./configure-process')
    const originalOverride = process.env.ORCA_DEV_USER_DATA_PATH
    process.env.ORCA_DEV_USER_DATA_PATH = '/tmp/orca-dev-repro'

    try {
      configureDevUserDataPath(true)
    } finally {
      if (originalOverride === undefined) {
        delete process.env.ORCA_DEV_USER_DATA_PATH
      } else {
        process.env.ORCA_DEV_USER_DATA_PATH = originalOverride
      }
    }

    expect(app.setPath).toHaveBeenCalledWith('userData', '/tmp/orca-dev-repro')
  })

  it('moves dev runs onto an orca-dev userData path', async () => {
    const { app } = await import('electron')
    const { configureDevUserDataPath } = await import('./configure-process')

    delete process.env.ORCA_DEV_USER_DATA_PATH
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

    vi.useFakeTimers()
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
    const { installDevParentWatchdog } = await import('./configure-process')

    vi.useFakeTimers()
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

describe('enableMainProcessGpuFeatures', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const originalE2EUserDataDir = process.env.ORCA_E2E_USER_DATA_DIR

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: platform
    })
  }

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    if (originalE2EUserDataDir === undefined) {
      delete process.env.ORCA_E2E_USER_DATA_DIR
    } else {
      process.env.ORCA_E2E_USER_DATA_DIR = originalE2EUserDataDir
    }
  })

  it('appends VS Code-style GPU channel flags without unsafe WebGPU/Vulkan opt-ins', async () => {
    const { app } = await import('electron')
    const { enableMainProcessGpuFeatures } = await import('./configure-process')

    delete process.env.ORCA_E2E_USER_DATA_DIR
    vi.mocked(app.commandLine.appendSwitch).mockClear()
    enableMainProcessGpuFeatures()

    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith(
      'enable-features',
      'EarlyEstablishGpuChannel,EstablishGpuChannelAsync'
    )
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith('enable-unsafe-webgpu')
  })

  it('disables the GPU process for Linux E2E runs', async () => {
    const { app } = await import('electron')
    const { enableMainProcessGpuFeatures } = await import('./configure-process')

    setPlatform('linux')
    process.env.ORCA_E2E_USER_DATA_DIR = '/tmp/orca-e2e'
    vi.mocked(app.disableHardwareAcceleration).mockClear()
    vi.mocked(app.commandLine.appendSwitch).mockClear()

    enableMainProcessGpuFeatures()

    expect(app.disableHardwareAcceleration).toHaveBeenCalledTimes(1)
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('disable-gpu')
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith(
      'enable-features',
      expect.any(String)
    )
  })

  it('preserves existing enable-features switches', async () => {
    const { app } = await import('electron')
    const { enableMainProcessGpuFeatures } = await import('./configure-process')

    delete process.env.ORCA_E2E_USER_DATA_DIR
    vi.mocked(app.commandLine.appendSwitch).mockClear()
    vi.mocked(app.commandLine.getSwitchValue).mockReturnValue('ExistingFeature')
    enableMainProcessGpuFeatures()

    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith(
      'enable-features',
      'EarlyEstablishGpuChannel,EstablishGpuChannelAsync,ExistingFeature'
    )
  })
})
