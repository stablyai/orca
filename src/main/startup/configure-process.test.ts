import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'

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
    },
    shell: { openExternal: vi.fn() }
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

  // #18234: a seeded ~/.local/bin/gh wrapper outranked /usr/bin/gh and recursively spawned itself through mise.
  it('never lets a seeded user dir overtake a system dir already on PATH', async () => {
    const { app } = await import('electron')
    const { patchPackagedProcessPath } = await import('./configure-process')

    setPlatform('linux')
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
    process.env.HOME = '/home/tester'
    process.env.PATH = '/usr/local/bin:/usr/bin:/bin'

    patchPackagedProcessPath()

    const segments = (process.env.PATH ?? '').split(':')
    const localBin = segments.indexOf(join('/home/tester', '.local/bin'))
    expect(localBin).toBeGreaterThan(-1)
    for (const systemDir of ['/usr/bin', '/bin', '/usr/local/bin']) {
      expect(segments.indexOf(systemDir)).toBeLessThan(localBin)
    }
    expect(segments.indexOf(join('/home/tester', 'bin'))).toBeGreaterThan(
      segments.indexOf('/usr/bin')
    )
  })

  it('keeps version-manager shims ahead of the inherited PATH', async () => {
    const { app } = await import('electron')
    const { patchPackagedProcessPath } = await import('./configure-process')
    const { getVersionManagerBinPaths } = await import('../../shared/node-cli-command-resolution')

    setPlatform('linux')
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
    process.env.HOME = '/home/tester'
    process.env.PATH = '/usr/bin:/bin'

    patchPackagedProcessPath()

    const segments = (process.env.PATH ?? '').split(':')
    const genericUserBinDirs = [join('/home/tester', 'bin'), join('/home/tester', '.local/bin')]
    const seeded = getVersionManagerBinPaths({ platform: 'linux', homePath: '/home/tester' })
    const shimDirs = seeded.filter((dir) => !genericUserBinDirs.includes(dir))
    expect(shimDirs).not.toHaveLength(0)
    // Version-manager shims must outrank system runtimes.
    for (const dir of shimDirs) {
      expect(segments.indexOf(dir)).toBeLessThan(segments.indexOf('/usr/bin'))
    }
    // Generic user bins hold arbitrary wrappers and must remain behind inherited system tools.
    for (const dir of genericUserBinDirs) {
      expect(segments.indexOf(dir)).toBeGreaterThan(segments.indexOf('/usr/bin'))
    }
  })

  it('prepends Windows user-local CLI dirs for packaged Start Menu launches', async () => {
    const { app } = await import('electron')
    const { patchPackagedProcessPath } = await import('./configure-process')

    setPlatform('win32')
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
    vi.stubEnv('FNM_DIR', 'C:\\fnm')
    onTestFinished(() => {
      vi.unstubAllEnvs()
    })
    const pathDelimiter = process.platform === 'win32' ? ';' : ':'
    process.env.PATH = `C:\\Windows\\System32${pathDelimiter}C:\\Windows`

    patchPackagedProcessPath()

    const segments = (process.env.PATH ?? '').split(pathDelimiter)
    const userLocalBin = join(homedir(), '.local', 'bin')
    expect(segments).toContain(userLocalBin)
    expect(segments.indexOf(userLocalBin)).toBeLessThan(segments.indexOf('C:\\Windows\\System32'))
    // #11356: fnm's default Node only backfills; it must not shadow an inherited system Node.
    const fnmAlias = join('C:\\fnm', 'aliases', 'default')
    expect(segments.indexOf(fnmAlias)).toBeGreaterThan(segments.indexOf('C:\\Windows'))
  })
})

describe('configureDevUserDataPath', () => {
  it('rejects an E2E launch whose Node home escaped the disposable profile', async () => {
    const { configureDevUserDataPath } = await import('./configure-process')
    const originalE2EUserDataDir = process.env.ORCA_E2E_USER_DATA_DIR
    const originalE2EHomeDir = process.env.ORCA_E2E_HOME_DIR
    const originalHome = process.env.HOME
    const originalUserProfile = process.env.USERPROFILE
    const e2eRoot = mkdtempSync(join(tmpdir(), 'orca-configure-e2e-escape-'))
    process.env.ORCA_E2E_USER_DATA_DIR = e2eRoot
    process.env.ORCA_E2E_HOME_DIR = join(e2eRoot, 'home')
    process.env.HOME = join(e2eRoot, 'escaped-home')
    process.env.USERPROFILE = join(e2eRoot, 'escaped-home')

    try {
      expect(() => configureDevUserDataPath(true)).toThrow(/disposable home boundary/)
    } finally {
      rmSync(e2eRoot, { recursive: true, force: true })
      restoreEnv('ORCA_E2E_USER_DATA_DIR', originalE2EUserDataDir)
      restoreEnv('ORCA_E2E_HOME_DIR', originalE2EHomeDir)
      restoreEnv('HOME', originalHome)
      restoreEnv('USERPROFILE', originalUserProfile)
    }
  })
})

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

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

  it('drops a runtime source inherited from the Orca terminal that started this Orca', async () => {
    const { app } = await import('electron')
    const { configureOrcaUserDataPathEnv } = await import('./configure-process')
    const saved = { ...process.env }
    process.env.ORCA_RUNTIME_SOURCE_ID = 'parent-source'
    process.env.ORCA_RUNTIME_SOURCE_INCARNATION = 'parent-runtime'
    app.setPath('userData', '/tmp/current-orca-user-data')
    let inherited: (string | undefined)[] = []

    try {
      configureOrcaUserDataPathEnv()
      inherited = [process.env.ORCA_RUNTIME_SOURCE_ID, process.env.ORCA_RUNTIME_SOURCE_INCARNATION]
    } finally {
      process.env = saved
    }

    expect(inherited).toEqual([undefined, undefined])
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

  function createProfileState(
    userDataPath: string,
    profileId: string,
    settings: Record<string, unknown>
  ): string {
    const profileDirectory = join(userDataPath, 'profiles', profileId)
    mkdirSync(profileDirectory, { recursive: true })
    writeFileSync(
      join(userDataPath, 'orca-profile-index.json'),
      JSON.stringify({ activeProfileId: profileId, profiles: [{ id: profileId }] }),
      'utf-8'
    )
    writeFileSync(join(profileDirectory, 'orca-data.json'), JSON.stringify({ settings }), 'utf-8')
    return profileDirectory
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

  it('answers from the marker without reading the settings file', async () => {
    const { shouldDisableHttp2ForElectronNetworking } = await import('./configure-process')
    const { writeHttp1CompatibilityMarker } =
      await import('./network-compatibility/http1-compatibility-marker')
    const userDataPath = createUserDataDir({ electronHttp1CompatibilityMode: false })
    writeHttp1CompatibilityMarker(userDataPath, true)
    rmSync(join(userDataPath, 'orca-data.json'), { force: true })

    expect(shouldDisableHttp2ForElectronNetworking({ env: {}, userDataPath })).toBe(true)
  })

  it('falls back to the settings file when the marker is corrupt', async () => {
    const { shouldDisableHttp2ForElectronNetworking } = await import('./configure-process')
    const userDataPath = createUserDataDir({ electronHttp1CompatibilityMode: true })
    writeFileSync(join(userDataPath, 'http1-compatibility.json'), '{ not json', 'utf-8')

    expect(shouldDisableHttp2ForElectronNetworking({ env: {}, userDataPath })).toBe(true)
  })

  it('lets the environment override the marker', async () => {
    const { shouldDisableHttp2ForElectronNetworking } = await import('./configure-process')
    const { writeHttp1CompatibilityMarker } =
      await import('./network-compatibility/http1-compatibility-marker')
    const userDataPath = createUserDataDir({})
    writeHttp1CompatibilityMarker(userDataPath, true)

    expect(
      shouldDisableHttp2ForElectronNetworking({ env: { ORCA_DISABLE_HTTP2: '0' }, userDataPath })
    ).toBe(false)
  })

  it('scopes a profile marker to the active profile before trusting it', async () => {
    const { shouldDisableHttp2ForElectronNetworking } = await import('./configure-process')
    const { writeHttp1CompatibilityMarker } =
      await import('./network-compatibility/http1-compatibility-marker')
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-http1-profile-'))
    tempDirs.push(userDataPath)
    createProfileState(userDataPath, 'profile-b', { electronHttp1CompatibilityMode: false })
    writeHttp1CompatibilityMarker(userDataPath, true, 'profile-a')

    expect(shouldDisableHttp2ForElectronNetworking({ env: {}, userDataPath })).toBe(false)
  })

  it('uses a matching profile marker even when the legacy JSON is stale', async () => {
    const { shouldDisableHttp2ForElectronNetworking } = await import('./configure-process')
    const { writeHttp1CompatibilityMarker } =
      await import('./network-compatibility/http1-compatibility-marker')
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-http1-profile-'))
    tempDirs.push(userDataPath)
    createProfileState(userDataPath, 'profile-b', { electronHttp1CompatibilityMode: false })
    writeHttp1CompatibilityMarker(userDataPath, true, 'profile-b')

    expect(shouldDisableHttp2ForElectronNetworking({ env: {}, userDataPath })).toBe(true)
  })

  it('fails closed when a profile database exists without a trusted marker', async () => {
    const { shouldDisableHttp2ForElectronNetworking } = await import('./configure-process')
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-http1-profile-'))
    tempDirs.push(userDataPath)
    const profileDirectory = createProfileState(userDataPath, 'profile-b', {
      electronHttp1CompatibilityMode: true
    })
    writeFileSync(join(profileDirectory, 'profile-state.db'), 'sqlite-present', 'utf-8')

    expect(shouldDisableHttp2ForElectronNetworking({ env: {}, userDataPath })).toBe(false)
  })
})
