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
  const originalWaylandDisplay = process.env.WAYLAND_DISPLAY
  const originalXdgSessionType = process.env.XDG_SESSION_TYPE

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
    if (originalWaylandDisplay === undefined) {
      delete process.env.WAYLAND_DISPLAY
    } else {
      process.env.WAYLAND_DISPLAY = originalWaylandDisplay
    }
    if (originalXdgSessionType === undefined) {
      delete process.env.XDG_SESSION_TYPE
    } else {
      process.env.XDG_SESSION_TYPE = originalXdgSessionType
    }
  })

  it('appends Orca GPU flags on darwin', async () => {
    const { app } = await import('electron')
    const { enableMainProcessGpuFeatures } = await import('./configure-process')

    vi.mocked(app.commandLine.appendSwitch).mockClear()
    setPlatform('darwin')
    enableMainProcessGpuFeatures()

    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith(
      'enable-features',
      'Vulkan,UseSkiaGraphite'
    )
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('enable-unsafe-webgpu')
  })

  it('appends Orca GPU flags on linux X11 sessions', async () => {
    // Why: Chromium's X11 Vulkan path works, so we keep Skia Graphite / WebGPU
    // acceleration on X11. Only Wayland hits the wayland_surface_factory.cc
    // incompatibility and needs the gate.
    const { app } = await import('electron')
    const { enableMainProcessGpuFeatures } = await import('./configure-process')

    vi.mocked(app.commandLine.appendSwitch).mockClear()
    setPlatform('linux')
    delete process.env.WAYLAND_DISPLAY
    process.env.XDG_SESSION_TYPE = 'x11'
    enableMainProcessGpuFeatures()

    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith(
      'enable-features',
      'Vulkan,UseSkiaGraphite'
    )
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('enable-unsafe-webgpu')
  })

  it('skips Vulkan/SkiaGraphite/WebGPU switches when WAYLAND_DISPLAY is set', async () => {
    // Why: Chromium's Ozone/Wayland surface factory hard-aborts with Vulkan
    // enabled (wayland_surface_factory.cc:251), producing a blank/transparent
    // window on Wayland-default distros (Arch/Omarchy/Hyprland, GNOME-Wayland).
    const { app } = await import('electron')
    const { enableMainProcessGpuFeatures } = await import('./configure-process')

    vi.mocked(app.commandLine.appendSwitch).mockClear()
    setPlatform('linux')
    process.env.WAYLAND_DISPLAY = 'wayland-0'
    delete process.env.XDG_SESSION_TYPE
    enableMainProcessGpuFeatures()

    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled()
  })

  it('skips switches when XDG_SESSION_TYPE=wayland without WAYLAND_DISPLAY', async () => {
    // Why: belt-and-suspenders — some nested/manually-started Wayland sessions
    // advertise XDG_SESSION_TYPE=wayland without yet having WAYLAND_DISPLAY
    // set in the process's environment at launch time.
    const { app } = await import('electron')
    const { enableMainProcessGpuFeatures } = await import('./configure-process')

    vi.mocked(app.commandLine.appendSwitch).mockClear()
    setPlatform('linux')
    delete process.env.WAYLAND_DISPLAY
    process.env.XDG_SESSION_TYPE = 'wayland'
    enableMainProcessGpuFeatures()

    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled()
  })
})
