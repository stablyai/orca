import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  configureRelayBundledRipgrep,
  isDriveRootedWindowsPath,
  pathRipgrepCommand,
  resetRelayRipgrepPathCacheForTests
} from './relay-bundled-ripgrep'

const originalPlatform = process.platform
const originalPath = process.env.PATH

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { configurable: true, value })
}

describe('relay PATH ripgrep resolution', () => {
  afterEach(() => {
    setPlatform(originalPlatform)
    process.env.PATH = originalPath
    resetRelayRipgrepPathCacheForTests()
    configureRelayBundledRipgrep(undefined)
  })

  // Why a pure predicate test and not a filesystem one: the walk applies win32 path semantics, and
  // a temp directory on a POSIX CI host has no drive letter to exercise them with.
  it('accepts only drive-lettered and UNC roots', () => {
    expect(isDriveRootedWindowsPath('C:\\tools')).toBe(true)
    expect(isDriveRootedWindowsPath('d:/tools')).toBe(true)
    expect(isDriveRootedWindowsPath('\\\\server\\share\\tools')).toBe(true)
    // Rooted but drive-less: `path.isAbsolute` says true, yet these resolve against whatever drive
    // the process is on -- the relay's for the probe, the user's repo for the spawn.
    expect(isDriveRootedWindowsPath('\\tools')).toBe(false)
    expect(isDriveRootedWindowsPath('/tools')).toBe(false)
    // Drive-relative, and relative.
    expect(isDriveRootedWindowsPath('C:tools')).toBe(false)
    expect(isDriveRootedWindowsPath('tools')).toBe(false)
  })

  // Why this matters on Windows only: CreateProcessW searches the spawn cwd -- the user's repo --
  // before PATH, so a bare `rg` there runs a planted rg.exe out of a cloned repository.
  it.runIf(process.platform === 'win32')('resolves an absolute rg.exe from PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-rg-'))
    try {
      writeFileSync(join(dir, 'rg.exe'), '')
      setPlatform('win32')
      process.env.PATH = `${join(dir, 'missing')}${delimiter}${dir}`
      resetRelayRipgrepPathCacheForTests()

      expect(pathRipgrepCommand()).toBe(join(dir, 'rg.exe'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns null on Windows rather than a bare name when PATH has no rg', () => {
    setPlatform('win32')
    process.env.PATH = join(tmpdir(), 'definitely-not-here')
    resetRelayRipgrepPathCacheForTests()

    expect(pathRipgrepCommand()).toBeNull()
  })

  // Why drive-rooted and not merely "absolute": path.isAbsolute accepts `\\tools` and `/tools` on
  // Windows. Those carry no drive, so the probe would validate them against the relay's drive
  // while the spawn -- running with the user's repo as cwd -- resolves them against the repo's.
  it('skips rooted PATH entries that carry no drive', () => {
    setPlatform('win32')
    process.env.PATH = `\\tools${delimiter}/tools${delimiter}C:tools`
    resetRelayRipgrepPathCacheForTests()

    expect(pathRipgrepCommand()).toBeNull()
  })

  // Why a relative PATH entry is skipped: it resolves against the cwd, the hazard being avoided.
  it('ignores relative PATH entries on Windows', () => {
    setPlatform('win32')
    process.env.PATH = `.${delimiter}node_modules/.bin`
    resetRelayRipgrepPathCacheForTests()

    expect(pathRipgrepCommand()).toBeNull()
  })

  // Why POSIX keeps the bare name: execvp never consults the cwd, so there is nothing to resolve.
  it('keeps the bare name on POSIX', () => {
    setPlatform('linux')
    resetRelayRipgrepPathCacheForTests()

    expect(pathRipgrepCommand()).toBe('rg')
  })
})
