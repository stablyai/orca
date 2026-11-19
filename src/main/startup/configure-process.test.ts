import { mkdtempSync, rmSync } from 'node:fs'
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
