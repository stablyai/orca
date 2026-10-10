import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as nodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Why a separate file rather than more cases in configure-process.test.ts: that
// file sits at the `max-lines` limit (800, non-blank/non-comment) already, and
// every case here is about the same contract — what a packaged launch's process
// environment ends up holding.
const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string | undefined>(() => undefined)
}))

// Why the account directory is mockable here: `homedir()` is not a total
// function, and the failure mode is only reachable by replacing it. When a case
// does not override it, the mock forwards to the real implementation, so those
// cases observe the same host truth the sibling suite does.
// Why no `vi.spyOn(os, 'homedir')` instead: the ESM namespace object is not
// extensible and its properties are non-configurable — measured, `Object
// .getOwnPropertyDescriptor(await import('node:os'), 'homedir')` reports
// `configurable: false` — so a spy cannot rebind the import the source holds.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeOs>()
  return {
    ...actual,
    // Why the forwarding rather than a default implementation on the mock: the
    // mock factory runs before this file's own imports resolve, so a
    // `() => homedir()` default would call the mock through this same shim and
    // recurse. `actual.homedir` is the only non-recursive route to the real one.
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
  const tempDirs: string[] = []

  // Why read here rather than inside a case: the host platform has to be captured
  // before any case forces `process.platform`, and this describe body runs at
  // collection time.
  // Why the assertion needs it at all: `node:path`'s `join` is bound to the host at
  // import, and the seed builds its `~`-derived entries with it, so forcing a
  // platform changes the entries' separator not at all. On a Windows host a
  // forced-linux launch yields `\home\…\.volta\bin`, which POSIX reads as relative —
  // so a POSIX-only `isAbsolute` would fail for the runner's OS rather than for the
  // seed. The defect under test is a segment a spawn resolves against its own cwd,
  // which is the host's question: `win32.isAbsolute` refuses the bare `.volta/bin`
  // just as `posix.isAbsolute` does.
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
    for (const key of ['HOME', 'PATH', 'Path'] as const) {
      const original = { HOME: originalHome, PATH: originalPath, Path: originalWindowsPath }[key]
      if (original === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = original
      }
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
    // Why mockReset and not clearAllMocks: clearing only drops the call log, so a
    // throwing implementation installed by one case would leak into the next and
    // the forwarding mock would never return to the real account directory.
    homedirMock.mockReset()
    vi.restoreAllMocks()
  })

  // Why this case exists (#23214): the seed is written as an *addition* to an
  // inherited PATH, so every sibling test hands the function `PATH=/usr/bin:/bin`
  // and the two distro bins are already in the string before seeding. A Hyprland
  // keybinding, a `systemd-run` launcher or an `.desktop` exec can start the
  // AppImage with no PATH at all, and then the seed *is* the PATH — and it named
  // no directory a distro package writes `gh` into, so `gh --version` reported a
  // missing CLI on a machine whose package manager had just installed it.
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

  // Why this case is the reported symptom itself, rather than a property of the
  // seed: `isCommandAvailable()` answers through `isCommandOnLocalPath()`, which
  // walks `process.env.PATH` with `node:fs` and counts only candidates that
  // resolve to an *absolute* path. With no PATH that walk starts from `['']`, so
  // `gh` becomes the relative `gh` and is skipped: `installed: false`, which is
  // exactly what #23214 reports. The same reporter got `gh --version` to exit 0
  // by hand in that captured environment, and both answers are correct — libuv
  // falls back to a default search path when PATH is absent and the fs walk does
  // not. Pinning the pair is the only way to keep the fix aimed at the verdict
  // the UI shows rather than at the PATH string it is derived from.
  it("answers the preflight's own spawn-free lookup after a launch with no PATH", async () => {
    const { app } = await import('electron')
    const { patchPackagedProcessPath } = await import('./configure-process')
    const { isCommandOnLocalPath } = await import('../ipc/command-path-resolver')

    setPlatform('linux')
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
    process.env.HOME = '/home/tester'
    delete process.env.PATH

    // Why `sh` and not `gh`: the candidate has to exist at a fixed absolute path
    // on every host that runs this suite, and `/bin/sh` is the one that does on
    // both macOS and Linux. The lookup is `node:fs` only, so asserting through it
    // keeps this inside the no-subprocess rule for the detection path (#9297).
    await expect(isCommandOnLocalPath('sh')).resolves.toBe(false)

    patchPackagedProcessPath()

    await expect(isCommandOnLocalPath('sh')).resolves.toBe(true)
  })

  // Why separate from the same rule with an inherited PATH: there the system dirs
  // are already in `currentSegments`, so the dedupe keeps them wherever the user
  // put them and the appended block's internal order cannot be observed. With no
  // PATH both sides come from the seed, which is the only place that order is
  // testable — and #18234 is about that exact order: a `~/.local/bin/gh` wrapper
  // running `mise x gh -- gh` recursed once it outranked `/usr/bin/gh`.
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
      // Why the explicit >= 0: without it `indexOf` returning -1 would satisfy
      // "less than localBin" and the assertion would pass on a seed that omits
      // the directory entirely.
      expect(segments.indexOf(systemDir), systemDir).toBeGreaterThanOrEqual(0)
      expect(segments.indexOf(systemDir), systemDir).toBeLessThan(localBin)
    }
  })

  it('seeds HOME so a spawned CLI reads the same account directory the app resolved', async () => {
    // Why: with `$HOME` absent, `homedir()` still resolves the account directory
    // from the passwd entry — measured two ways: `env -u HOME node -e
    // 'os.homedir()'` returns the real home on this macOS host, and the same call
    // in a Linux container answers "/root" with `HOME` removed — so the app and a
    // spawned CLI disagree about where the user's configuration lives. That is
    // #23214's second symptom, and it reproduces against the real binary: on a
    // host that is logged in, `gh auth token` prints the token while the same
    // spawn with `HOME` removed prints "no oauth token found for github.com".
    // It also costs seed entries: every `~`-derived dir is built from
    // `process.env.HOME`, so an unset HOME silently drops all of them.
    const { app } = await import('electron')
    const { patchPackagedProcessPath } = await import('./configure-process')
    // Why the account directory is a literal: the assertion is that the seed
    // adopts the answer, and a value taken from the same call under test would
    // pass against any answer at all.
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

    // Why both: a dev launch inherits the shell that started it, so writing an
    // env var it left unset would mask exactly the bug being debugged.
    expect(process.env.PATH).toBeUndefined()
    expect(process.env.HOME).toBeUndefined()
  })

  // Why this is the sharp half of #18234 rather than a restatement of the row
  // above: the two new entries are system directories, and the seed's whole reason
  // for being ordered is that a version manager's shim must outrank a system
  // install — hoist `/usr/bin` to the front and an nvm/mise user silently gets the
  // distro runtime, which is the bug that list exists to avoid. The shim dirs are
  // produced unconditionally, so this pins real positions rather than ones that
  // happen to exist on the host.
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

  // Why a real child rather than another assertion on `process.env.PATH`: both
  // symptoms in #23214 are about what a spawned CLI inherits, not what the main
  // process knows. A test that only reads the variable back passes even if the
  // repair lands too late for `spawn`, or writes a key the child never reads.
  it('gives a spawned child the repaired HOME and a PATH that resolves a CLI', async () => {
    const { app } = await import('electron')
    const { patchPackagedProcessPath } = await import('./configure-process')

    // Why a constructed CLI in a constructed home: asserting on a binary this
    // host happens to ship (`gh` is Homebrew here, a distro package on the
    // reporter's) would make the pass depend on the machine. `<home>/bin` is a
    // directory the seed appends, so a hit here can only come from the seed.
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
    // Why the absolute interpreter: with no PATH a *bare* `sh` would not spawn,
    // and the test would measure the harness rather than the seed.
    const child = spawnSync(
      '/bin/sh',
      ['-c', `printf '%s\\0%s\\0%s' "$HOME" "$PATH" "$(command -v ${marker})"`],
      { encoding: 'utf8' }
    )

    expect(child.status).toBe(0)
    const [childHome, childPath, childCli] = (child.stdout ?? '').split('\0')
    expect(childHome).toBe(home)
    // Why equality rather than a re-derivation: the contract is that the child's
    // environment *is* the repaired one, key for key.
    expect(childPath).toBe(parentPath)
    expect(childPath.split(':')).toContain('/usr/bin')
    expect(childCli, 'CLI reachable only through the seeded PATH').toBe(cliPath)
  })

  // Why this shape is real and not hypothetical: measured on a Linux container run
  // as uid 12345 — an account with no passwd entry, which is what a mapped
  // `docker run --user` looks like — with `HOME` removed, `os.homedir()` rejects
  // with `ERR_SYSTEM_ERROR` ("uv_os_homedir returned ENOENT"), as does
  // `os.userInfo()`. Before the account lookup was made total, the seed reached
  // that throw twice over: once for `HOME`, and once inside
  // `getVersionManagerBinPaths`, which is where it actually crashed first.
  it('keeps starting, and still seeds the system bins, when the account database cannot answer HOME', async () => {
    const { app } = await import('electron')
    const { patchPackagedProcessPath } = await import('./configure-process')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
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
    // Why PATH is still seeded: an unresolvable account directory drops only the
    // `~`-derived entries, and the system block is what makes a packaged `gh`
    // findable (#23214), so a failed lookup must not abort the rest of the repair.
    const segments = (process.env.PATH ?? '').split(':')
    expect(segments).toContain('/usr/bin')
    expect(segments).toContain('/bin')
  })

  // Why both guards get a case: the resolved value is checked before assignment
  // because an empty string is something `homedir()` can return without throwing,
  // and `process.env.HOME = ''` would keep every `~`-derived seed entry out of
  // PATH while making the app believe a HOME exists.
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
    // Why the seed still landed: the guard is about not inventing a value, not
    // about skipping the PATH repair.
    expect((process.env.PATH ?? '').split(':')).toContain('/usr/bin')
  })

  // Why this is a security assertion rather than a tidiness one: POSIX resolves a
  // relative PATH entry against the cwd of *each* spawn, so the bare names an
  // unresolvable home makes this seed produce — `.volta/bin`, `.asdf/shims`,
  // `.local/bin` — let a command run inside an untrusted worktree execute a binary
  // the repository planted under one of those names (CWE-426, raised on this seed by
  // pullfrog and CodeRabbit). The exposure came in with the account lookup becoming
  // total: the same host shape used to throw before it could write a PATH.
  // Why three unresolved shapes rather than one: `throw` and `empty` both end at
  // `accountHome ?? home === ''`, which is what made this seed emit `.volta/bin` and
  // its neighbours; a *relative* `HOME` — what a unit file or a `.desktop` exec can
  // hand a process — reaches the same expression by another route and lands in the
  // appended user bins instead of the prepended shims, so only a case of its own
  // keeps the guard honest about both lists.
  it.each([
    ['a lookup that throws', 'throw'],
    ['a lookup that answers an empty string', 'empty'],
    ['a HOME that is not absolute', 'relative']
  ] as const)(
    'seeds no PATH entry that a spawn could resolve against its own working directory, on %s',
    async (_label, mode) => {
      const { app } = await import('electron')
      const { patchPackagedProcessPath } = await import('./configure-process')
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      if (mode === 'throw') {
        homedirMock.mockImplementation(() => {
          throw Object.assign(new Error('uv_os_homedir returned ENOENT'), {
            code: 'ERR_SYSTEM_ERROR'
          })
        })
      } else if (mode === 'empty') {
        homedirMock.mockReturnValue('')
      } else {
        // Why a lookup that answers, for this case only: the version-manager list has
        // an absolute home to work from here, so a failure can only come from the
        // user-bin block the relative `HOME` feeds.
        homedirMock.mockReturnValue('/home/passwd-user')
      }

      setPlatform('linux')
      Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
      if (mode === 'relative') {
        process.env.HOME = '.relative-home'
      } else {
        delete process.env.HOME
      }
      delete process.env.PATH

      patchPackagedProcessPath()

      const segments = (process.env.PATH ?? '').split(':')
      // Why the non-empty guard first: a loop over an empty list passes
      // vacuously, and an empty seed would be its own regression.
      expect(segments.length).toBeGreaterThan(0)
      for (const segment of segments) {
        expect(isAbsolutePathOnHost(segment), segment).toBe(true)
      }
      // Why still assert the repair landed: the fix is to drop the `~`-derived
      // entries, not to stop seeding the system block that makes a packaged `gh`
      // findable (#23214).
      expect(segments).toContain('/usr/bin')
      expect(segments).toContain('/bin')
    }
  )

  it('uses the Windows account directory for the user bins without writing POSIX HOME', async () => {
    const { app } = await import('electron')
    const { patchPackagedProcessPath } = await import('./configure-process')
    // Why a value rather than a throw: Windows resolves the account directory from
    // `USERPROFILE`, and the seed is expected to use it for the user-local bin
    // dirs while still leaving POSIX `HOME` alone. A throwing mock would pass the
    // HOME assertion for the wrong reason.
    homedirMock.mockReturnValue('C:\\Users\\tester')

    setPlatform('win32')
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
    delete process.env.HOME
    process.env.Path = 'C:\\Windows\\System32'

    patchPackagedProcessPath()

    expect(process.env.HOME).toBeUndefined()
    const segments = (process.env.Path ?? process.env.PATH ?? '').split(';')
    // Why this is the Windows half of the same contract: the account directory
    // feeds the user-local bins even though it is never written to `HOME`.
    expect(segments).toContain(join('C:\\Users\\tester', 'AppData', 'Roaming', 'npm'))
    // Why `/usr/bin` is absent: the distro-bin block is POSIX-only, so a Windows
    // launch gains no entry it could not already resolve.
    expect(segments).not.toContain('/usr/bin')
    // Why the same rule on Windows: `AppData\Roaming\npm` is just as reachable
    // through a relative PATH entry as `.local/bin` is on POSIX, and the account
    // directory here is absolute, so nothing should be emitted relative.
    for (const segment of segments) {
      expect(win32.isAbsolute(segment), segment).toBe(true)
    }
  })
})
