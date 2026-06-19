import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
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
    expect(segments).toContain(join('/Users/tester', '.opencode/bin'))
    expect(segments).toContain(join('/Users/tester', '.vite-plus/bin'))
    expect(segments).toContain(join('/Users/tester', 'bin'))
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

  it('prepends Windows user-local CLI dirs for packaged Start Menu launches', async () => {
    const { app } = await import('electron')
    const { patchPackagedProcessPath } = await import('./configure-process')

    setPlatform('win32')
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
    const pathDelimiter = process.platform === 'win32' ? ';' : ':'
    process.env.PATH = `C:\\Windows\\System32${pathDelimiter}C:\\Windows`

    patchPackagedProcessPath()

    const segments = (process.env.PATH ?? '').split(pathDelimiter)
    const userLocalBin = join(homedir(), '.local', 'bin')
    expect(segments).toContain(userLocalBin)
    expect(segments.indexOf(userLocalBin)).toBeLessThan(segments.indexOf('C:\\Windows\\System32'))
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

describe('configureOrcaUserDataPathEnv', () => {
  it('overwrites stale inherited ORCA_USER_DATA_PATH with Electron userData', async () => {
    const { app } = await import('electron')
    const { configureOrcaUserDataPathEnv } = await import('./configure-process')
    const originalUserDataPath = process.env.ORCA_USER_DATA_PATH
    process.env.ORCA_USER_DATA_PATH = '/tmp/stale-orca-user-data'
    app.setPath('userData', '/tmp/current-orca-user-data')
    let configuredUserDataPath: string | undefined

    try {
      configureOrcaUserDataPathEnv()
      configuredUserDataPath = process.env.ORCA_USER_DATA_PATH
    } finally {
      if (originalUserDataPath === undefined) {
        delete process.env.ORCA_USER_DATA_PATH
      } else {
        process.env.ORCA_USER_DATA_PATH = originalUserDataPath
      }
    }

    expect(configuredUserDataPath).toBe('/tmp/current-orca-user-data')
  })
})

describe('shouldInstallManagedHooks', () => {
  it('keeps managed hook auto-install enabled for default dev runs', async () => {
    const { shouldInstallManagedHooks } = await import('./configure-process')

    expect(shouldInstallManagedHooks(true)).toBe(true)
  })

  it('allows managed hook auto-install for packaged runs', async () => {
    const { shouldInstallManagedHooks } = await import('./configure-process')

    expect(shouldInstallManagedHooks(false)).toBe(true)
  })
})

describe('configureElectronNetworkCompatibility', () => {
  const tempDirs: string[] = []
  const originalEnvValue = process.env.ORCA_DISABLE_HTTP2

  function createUserDataDir(settings: Record<string, unknown>): string {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-http1-compat-'))
    tempDirs.push(userDataPath)
    writeFileSync(join(userDataPath, 'orca-data.json'), JSON.stringify({ settings }), 'utf-8')
    return userDataPath
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
    if (originalEnvValue === undefined) {
      delete process.env.ORCA_DISABLE_HTTP2
    } else {
      process.env.ORCA_DISABLE_HTTP2 = originalEnvValue
    }
  })

  it('enables HTTP/1.1 compatibility when the persisted setting is on', async () => {
    const { shouldDisableHttp2ForElectronNetworking } = await import('./configure-process')
    const userDataPath = createUserDataDir({ electronHttp1CompatibilityMode: true })

    expect(shouldDisableHttp2ForElectronNetworking({ env: {}, userDataPath })).toBe(true)
  })

  it('leaves HTTP/2 enabled by default', async () => {
    const { shouldDisableHttp2ForElectronNetworking } = await import('./configure-process')
    const userDataPath = createUserDataDir({})

    expect(shouldDisableHttp2ForElectronNetworking({ env: {}, userDataPath })).toBe(false)
  })

  it('lets the environment override force compatibility on', async () => {
    const { shouldDisableHttp2ForElectronNetworking } = await import('./configure-process')

    expect(
      shouldDisableHttp2ForElectronNetworking({
        env: { ORCA_DISABLE_HTTP2: 'true' },
        userDataPath: createUserDataDir({ electronHttp1CompatibilityMode: false })
      })
    ).toBe(true)
  })

  it('lets the environment override force compatibility off', async () => {
    const { shouldDisableHttp2ForElectronNetworking } = await import('./configure-process')

    expect(
      shouldDisableHttp2ForElectronNetworking({
        env: { ORCA_DISABLE_HTTP2: '0' },
        userDataPath: createUserDataDir({ electronHttp1CompatibilityMode: true })
      })
    ).toBe(false)
  })

  it('appends Electron disable-http2 before sessions are created', async () => {
    const { app } = await import('electron')
    const { configureElectronNetworkCompatibility } = await import('./configure-process')
    const userDataPath = createUserDataDir({ electronHttp1CompatibilityMode: true })

    vi.mocked(app.commandLine.appendSwitch).mockClear()
    configureElectronNetworkCompatibility({ env: {}, userDataPath })

    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('disable-http2')
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
