import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as nodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// `configure-process.test.ts` is at the max-lines budget; this contract is the packaged launch's environment.
const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string | undefined>(() => undefined)
}))

// `node:os` exports are non-configurable, so `vi.spyOn` cannot rebind the `homedir` import the source holds.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeOs>()
  return {
    ...actual,
    // The mock factory runs before this file's imports resolve; `actual.homedir` is the only non-recursive route to the real one.
    homedir: () => homedirMock() ?? actual.homedir()
  }
})

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

describe('patchPackagedProcessPath packaged environment', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const originalHome = process.env.HOME
  const originalPath = process.env.PATH
  const originalWindowsPath = process.env.Path
  const originalFnmDir = process.env.FNM_DIR
  const tempDirs: string[] = []

  // The seed builds `~` entries with host-bound `path.join`, so absoluteness is the host's question even for a forced platform.
  const hostPlatform = process.platform
  const isAbsolutePathOnHost = hostPlatform === 'win32' ? win32.isAbsolute : posix.isAbsolute

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  }

  function makeTempHome(): string {
    const dir = mkdtempSync(join(tmpdir(), 'orca-23214-'))
    tempDirs.push(dir)
    return dir
  }

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    for (const key of ['HOME', 'PATH', 'Path', 'FNM_DIR'] as const) {
      const original = {
        HOME: originalHome,
        PATH: originalPath,
        Path: originalWindowsPath,
        FNM_DIR: originalFnmDir
      }[key]
      if (original === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = original
      }
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
    // Clearing keeps the call log but leaves a throwing implementation installed by an earlier case.
    homedirMock.mockReset()
    vi.restoreAllMocks()
  })

  it('keeps the distro system bins in the seed so a launch with no PATH can still find a packaged CLI', async () => {
    const { app } = await import('electron')
    const { patchPackagedProcessPath } = await import('./configure-process')

    setPlatform('linux')
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
    process.env.HOME = '/home/tester'
    delete process.env.PATH

    patchPackagedProcessPath()

    const segments = (process.env.PATH ?? '').split(':')
    expect(segments).toContain('/usr/bin')
    expect(segments).toContain('/bin')
  })

  it.skipIf(hostPlatform === 'win32')(
    "answers the preflight's own spawn-free lookup after a launch with no PATH",
    async () => {
      const { app } = await import('electron')
      const { patchPackagedProcessPath } = await import('./configure-process')
      const { isCommandOnLocalPath } = await import('../ipc/command-path-resolver')

      setPlatform('linux')
      Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
      process.env.HOME = '/home/tester'
      delete process.env.PATH

      // `/bin/sh` exists at a fixed absolute path on every POSIX runner, and this stays inside the no-subprocess rule (#9297).
      await expect(isCommandOnLocalPath('sh')).resolves.toBe(false)

      patchPackagedProcessPath()

      await expect(isCommandOnLocalPath('sh')).resolves.toBe(true)
    }
  )

  it('keeps a seeded user bin dir behind a seeded system bin when the launch had no PATH', async () => {
    const { app } = await import('electron')
    const { patchPackagedProcessPath } = await import('./configure-process')

    setPlatform('linux')
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
    process.env.HOME = '/home/tester'
    delete process.env.PATH

    patchPackagedProcessPath()

    const segments = (process.env.PATH ?? '').split(':')
    const localBin = segments.indexOf(join('/home/tester', '.local/bin'))
    expect(localBin).toBeGreaterThan(-1)
    for (const systemDir of ['/usr/bin', '/bin', '/usr/local/bin']) {
      // Without >= 0, an omitted directory returns -1 and still satisfies "less than localBin".
      expect(segments.indexOf(systemDir), systemDir).toBeGreaterThanOrEqual(0)
      expect(segments.indexOf(systemDir), systemDir).toBeLessThan(localBin)
    }
  })

  it('seeds HOME so a spawned CLI reads the same account directory the app resolved', async () => {
    const { app } = await import('electron')
    const { patchPackagedProcessPath } = await import('./configure-process')
    // A literal, not the call under test: otherwise any answer passes.
    homedirMock.mockReturnValue('/home/passwd-user')

    setPlatform('linux')
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
    delete process.env.HOME
    process.env.PATH = '/usr/bin:/bin'

    patchPackagedProcessPath()

    expect(process.env.HOME).toBe('/home/passwd-user')
    const segments = (process.env.PATH ?? '').split(':')
    expect(segments).toContain(join('/home/passwd-user', '.local/bin'))
    expect(segments).toContain(join('/home/passwd-user', '.opencode/bin'))
  })

  it('does not invent a POSIX HOME on Windows, where USERPROFILE carries it', async () => {
    const { app } = await import('electron')
    const { patchPackagedProcessPath } = await import('./configure-process')

    setPlatform('win32')
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
    delete process.env.HOME
    process.env.PATH = 'C:\\Windows\\System32;C:\\Windows'

    patchPackagedProcessPath()

    expect(process.env.HOME).toBeUndefined()
  })

  it('repairs nothing when the app is not packaged', async () => {
    const { app } = await import('electron')
    const { patchPackagedProcessPath } = await import('./configure-process')

    setPlatform('linux')
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: false })
    delete process.env.HOME
    delete process.env.PATH

    patchPackagedProcessPath()

    // A dev launch inherits the shell that started it; writing an unset var hides the bug being debugged.
    expect(process.env.PATH).toBeUndefined()
    expect(process.env.HOME).toBeUndefined()
  })

  it('keeps the seeded system bins behind a version-manager shim dir', async () => {
    const { app } = await import('electron')
    const { patchPackagedProcessPath } = await import('./configure-process')
    homedirMock.mockReturnValue('/home/passwd-user')

    setPlatform('linux')
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
    delete process.env.HOME
    delete process.env.PATH

    patchPackagedProcessPath()

    const segments = (process.env.PATH ?? '').split(':')
    const firstShim = segments.indexOf(join('/home/passwd-user', '.volta', 'bin'))
    expect(firstShim, '.volta/bin').toBeGreaterThanOrEqual(0)
    for (const systemDir of ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin']) {
      expect(segments.indexOf(systemDir), systemDir).toBeGreaterThan(firstShim)
    }
  })

  it.skipIf(hostPlatform === 'win32')(
    'gives a spawned child the repaired HOME and a PATH that resolves a CLI',
    async () => {
      const { app } = await import('electron')
      const { patchPackagedProcessPath } = await import('./configure-process')

      // Both symptoms are about what a child inherits; `<home>/bin` is seed-appended, so a hit can only come from the seed.
      const home = makeTempHome()
      const marker = 'orca-23214-probe-cli'
      mkdirSync(join(home, 'bin'), { recursive: true })
      const cliPath = join(home, 'bin', marker)
      writeFileSync(cliPath, '#!/bin/sh\necho ran\n')
      chmodSync(cliPath, 0o755)

      setPlatform('linux')
      Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
      homedirMock.mockReturnValue(home)
      process.env.HOME = home
      delete process.env.PATH
      delete process.env.Path

      patchPackagedProcessPath()

      const parentPath = process.env.PATH ?? ''
      // An absolute interpreter, so a missing PATH doesn't make the harness rather than the seed the failure.
      const child = spawnSync(
        '/bin/sh',
        ['-c', `printf '%s\\0%s\\0%s' "$HOME" "$PATH" "$(command -v ${marker})"`],
        { encoding: 'utf8' }
      )

      expect(child.status).toBe(0)
      const [childHome, childPath, childCli] = (child.stdout ?? '').split('\0')
      expect(childHome).toBe(home)
      expect(childPath).toBe(parentPath)
      expect(childPath.split(':')).toContain('/usr/bin')
      expect(childCli, 'CLI reachable only through the seeded PATH').toBe(cliPath)
    }
  )

  it('keeps starting, and still seeds the system bins, when the account database cannot answer HOME', async () => {
    const { app } = await import('electron')
    const { patchPackagedProcessPath } = await import('./configure-process')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Measured in a Linux container as uid 12345 (no passwd entry) with HOME removed: uv_os_homedir returns ENOENT.
    homedirMock.mockImplementation(() => {
      throw Object.assign(new Error('uv_os_homedir returned ENOENT'), { code: 'ERR_SYSTEM_ERROR' })
    })

    setPlatform('linux')
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
    delete process.env.HOME
    delete process.env.PATH

    patchPackagedProcessPath()

    expect(process.env.HOME).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    // A failed lookup drops only the `~` entries; it must not abort the system block.
    const segments = (process.env.PATH ?? '').split(':')
    expect(segments).toContain('/usr/bin')
    expect(segments).toContain('/bin')
  })

  it('does not write an empty HOME when the platform resolves no account directory', async () => {
    const { app } = await import('electron')
    const { patchPackagedProcessPath } = await import('./configure-process')
    homedirMock.mockReturnValue('')

    setPlatform('linux')
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
    delete process.env.HOME
    delete process.env.PATH

    patchPackagedProcessPath()

    expect(process.env.HOME).toBeUndefined()
    expect((process.env.PATH ?? '').split(':')).toContain('/usr/bin')
  })

  // A relative PATH entry resolves against each spawn's cwd, so an unresolvable home let an untrusted worktree plant `.local/bin/gh` (CWE-426).
  // The shapes reach the guards by different routes: throw and empty empty the account home, a relative HOME feeds the appended user bins, and both together feed the prepended shims.
  it.each([
    ['a lookup that throws', 'throw'],
    ['a lookup that answers an empty string', 'empty'],
    ['a HOME that is not absolute', 'relative'],
    ['a HOME that is not absolute and no account entry', 'relative-no-account']
  ] as const)(
    'seeds no PATH entry that a spawn could resolve against its own working directory, on %s',
    async (_label, mode) => {
      const { app } = await import('electron')
      const { patchPackagedProcessPath } = await import('./configure-process')
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      if (mode === 'throw' || mode === 'relative-no-account') {
        homedirMock.mockImplementation(() => {
          throw Object.assign(new Error('uv_os_homedir returned ENOENT'), {
            code: 'ERR_SYSTEM_ERROR'
          })
        })
      } else if (mode === 'empty') {
        homedirMock.mockReturnValue('')
      } else {
        // This case's version-manager home is absolute, so only the relative `HOME` can emit a relative entry.
        homedirMock.mockReturnValue('/home/passwd-user')
      }

      setPlatform('linux')
      Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
      if (mode === 'relative' || mode === 'relative-no-account') {
        process.env.HOME = '.relative-home'
      } else {
        delete process.env.HOME
      }
      delete process.env.PATH

      patchPackagedProcessPath()

      const segments = (process.env.PATH ?? '').split(':')
      // A vacuous loop over an empty seed would otherwise pass.
      expect(segments.length).toBeGreaterThan(0)
      for (const segment of segments) {
        expect(isAbsolutePathOnHost(segment), segment).toBe(true)
      }
      expect(segments).toContain('/usr/bin')
      expect(segments).toContain('/bin')
    }
  )

  it('seeds the version-manager shims from an inherited absolute HOME when the account lookup throws', async () => {
    const { app } = await import('electron')
    const { patchPackagedProcessPath } = await import('./configure-process')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The repair made the first lookup total; threading `homePath` is what keeps the second one, inside getVersionManagerBinPaths, from running at all.
    homedirMock.mockImplementation(() => {
      throw Object.assign(new Error('uv_os_homedir returned ENOENT'), { code: 'ERR_SYSTEM_ERROR' })
    })

    setPlatform('linux')
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
    process.env.HOME = '/home/tester'
    delete process.env.PATH

    patchPackagedProcessPath()

    expect(process.env.HOME).toBe('/home/tester')
    expect(warn).toHaveBeenCalledTimes(1)
    const segments = (process.env.PATH ?? '').split(':')
    const firstShim = segments.indexOf(join('/home/tester', '.volta', 'bin'))
    expect(
      firstShim,
      'shims come from the inherited HOME, not the account lookup'
    ).toBeGreaterThanOrEqual(0)
    for (const systemDir of ['/usr/bin', '/bin']) {
      expect(segments.indexOf(systemDir), systemDir).toBeGreaterThan(firstShim)
    }
  })

  it('uses the Windows account directory for the user bins without writing POSIX HOME', async () => {
    const { app } = await import('electron')
    const { patchPackagedProcessPath } = await import('./configure-process')
    // A value, not a throw: `USERPROFILE` resolves here, so the HOME assertion must pass because POSIX HOME is untouched.
    homedirMock.mockReturnValue('C:\\Users\\tester')

    setPlatform('win32')
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
    delete process.env.HOME
    process.env.Path = 'C:\\Windows\\System32'

    patchPackagedProcessPath()

    expect(process.env.HOME).toBeUndefined()
    const segments = (process.env.Path ?? process.env.PATH ?? '').split(';')
    expect(segments).toContain(join('C:\\Users\\tester', 'AppData', 'Roaming', 'npm'))
    // The distro-bin block is POSIX-only.
    expect(segments).not.toContain('/usr/bin')
    for (const segment of segments) {
      expect(win32.isAbsolute(segment), segment).toBe(true)
    }
  })

  it('classifies the fnm default alias without a second home lookup when the Windows account lookup throws', async () => {
    const { app } = await import('electron')
    const { patchPackagedProcessPath } = await import('./configure-process')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Before the fix this is the second call, and the packaged launch aborted with PATH unpatched.
    homedirMock.mockImplementation(() => {
      throw Object.assign(new Error('uv_os_homedir returned ENOENT'), { code: 'ERR_SYSTEM_ERROR' })
    })

    setPlatform('win32')
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
    // An absolute value under win32 syntax, which is the syntax the forced platform checks.
    process.env.HOME = 'C:\\Users\\tester'
    // Pinned so the alias dir is one entry and host APPDATA cannot vary the expected seed.
    process.env.FNM_DIR = 'C:\\Users\\tester\\fnm'
    process.env.Path = 'C:\\Windows\\System32'

    patchPackagedProcessPath()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(homedirMock).toHaveBeenCalledTimes(1)
    const segments = (process.env.Path ?? '').split(';')
    const system32 = segments.indexOf('C:\\Windows\\System32')
    const fnmDefault = join('C:\\Users\\tester\\fnm', 'aliases', 'default')
    // Shims still lead PATH...
    expect(segments.indexOf(join('C:\\Users\\tester', '.volta', 'bin')), '.volta/bin').toBeLessThan(
      system32
    )
    // ...while the fnm default only backfills, so it stays behind the inherited system Node.
    expect(segments.indexOf(fnmDefault), fnmDefault).toBeGreaterThan(system32)
  })
})
