import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFs from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

const { fsMockState } = vi.hoisted(() => ({
  fsMockState: {
    failLink: false,
    failSymlink: false,
    failReplacementInstall: false,
    afterReplacementCopy: null as null | (() => void),
    afterFailedSourceLink: null as null | (() => void),
    beforePreservedRestoreLink: null as null | (() => void),
    fakeSymlinks: new Map<string, string>()
  }
}))

function isWindowsSymlinkPrivilegeError(error: unknown): boolean {
  if (process.platform !== 'win32' || !(error instanceof Error)) {
    return false
  }
  const errorWithCode = error as Error & { code?: string }
  return errorWithCode.code === 'EPERM' || errorWithCode.code === 'EACCES'
}

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    copyFileSync: (...args: Parameters<typeof actual.copyFileSync>) => {
      const result = actual.copyFileSync(...args)
      if (
        String(args[1]).includes('.orca-link-') &&
        fsMockState.afterReplacementCopy !== null
      ) {
        const callback = fsMockState.afterReplacementCopy
        fsMockState.afterReplacementCopy = null
        callback()
      }
      return result
    },
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      const [sourcePath, targetPath] = args
      if (
        String(sourcePath).includes('.orca-preserved.displaced-') &&
        fsMockState.beforePreservedRestoreLink !== null
      ) {
        const callback = fsMockState.beforePreservedRestoreLink
        fsMockState.beforePreservedRestoreLink = null
        callback()
      }
      if (
        fsMockState.failReplacementInstall &&
        String(sourcePath).includes('.orca-link-') &&
        !String(targetPath).includes('.orca-preserved')
      ) {
        fsMockState.failReplacementInstall = false
        throw new Error('replacement install disabled for test')
      }
      if (fsMockState.failLink && !String(sourcePath).includes('codex-runtime-home')) {
        if (fsMockState.afterFailedSourceLink !== null) {
          const callback = fsMockState.afterFailedSourceLink
          fsMockState.afterFailedSourceLink = null
          callback()
        }
        throw new Error('hardlink disabled for test')
      }
      return actual.linkSync(...args)
    },
    lstatSync: ((path: Parameters<typeof actual.lstatSync>[0]) => {
      const stat = actual.lstatSync(path)
      if (!fsMockState.fakeSymlinks.has(String(path))) {
        return stat
      }
      // Why: Windows often disallows file symlink creation outside Developer
      // Mode; tests simulate the link metadata while keeping a real path.
      return { ...stat, isSymbolicLink: () => true }
    }) as typeof actual.lstatSync,
    readlinkSync: ((path: Parameters<typeof actual.readlinkSync>[0]) => {
      const fakeTarget = fsMockState.fakeSymlinks.get(String(path))
      if (fakeTarget !== undefined) {
        return fakeTarget
      }
      return actual.readlinkSync(path)
    }) as typeof actual.readlinkSync,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      const [oldPath, newPath] = args
      const fakeTarget = fsMockState.fakeSymlinks.get(String(oldPath))
      const result = actual.renameSync(...args)
      if (fakeTarget !== undefined) {
        fsMockState.fakeSymlinks.delete(String(oldPath))
        fsMockState.fakeSymlinks.set(String(newPath), fakeTarget)
      } else {
        fsMockState.fakeSymlinks.delete(String(newPath))
      }
      return result
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      fsMockState.fakeSymlinks.delete(String(args[0]))
      return actual.rmSync(...args)
    },
    symlinkSync: (...args: Parameters<typeof actual.symlinkSync>) => {
      if (fsMockState.failSymlink) {
        throw new Error('symlink disabled for test')
      }
      try {
        return actual.symlinkSync(...args)
      } catch (error) {
        if (!isWindowsSymlinkPrivilegeError(error)) {
          throw error
        }
        const [target, path] = args
        fsMockState.fakeSymlinks.set(String(path), String(target))
        actual.writeFileSync(path, '', 'utf-8')
      }
    }
  }
})

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: homedirMock
  }
})

import {
  syncSystemCodexSessionsIntoManagedHome,
  syncSystemCodexSessionsIntoManagedHomeIncrementally
} from './codex-session-bridge'

let fakeHomeDir: string
let userDataDir: string
let previousUserDataPath: string | undefined

function getSystemCodexHomePath(): string {
  return join(fakeHomeDir, '.codex')
}

function getRuntimeCodexHomePath(): string {
  return join(userDataDir, 'codex-runtime-home', 'home')
}

function getPreservedSessionPath(relativePath: string): string {
  return join(
    getRuntimeCodexHomePath(),
    '.orca-session-preserved',
    `${relativePath}.orca-preserved`
  )
}

function getPreservedSessionRecordPath(relativePath: string): string {
  return join(getRuntimeCodexHomePath(), '.orca-session-preserved', `${relativePath}.json`)
}

function normalizeLinkTarget(linkTarget: string): string {
  return process.platform === 'win32'
    ? linkTarget.replace(/^\\\\\?\\/, '').toLowerCase()
    : linkTarget
}

function expectResourceLinked(targetPath: string, sourcePath: string): void {
  if (lstatSync(targetPath).isSymbolicLink()) {
    expect(normalizeLinkTarget(readlinkSync(targetPath))).toBe(normalizeLinkTarget(sourcePath))
    return
  }
  expect(lstatSync(targetPath).ino).toBe(lstatSync(sourcePath).ino)
}

function writeLegacyCopyMarker(relativePath: string, sourcePath: string, targetPath: string): void {
  const sourceStat = lstatSync(sourcePath)
  const targetStat = lstatSync(targetPath)
  const markerPath = join(getRuntimeCodexHomePath(), '.orca-session-copies', `${relativePath}.json`)
  mkdirSync(dirname(markerPath), { recursive: true })
  writeFileSync(
    markerPath,
    `${JSON.stringify(
      {
        sourcePath,
        sourceSize: sourceStat.size,
        sourceMtimeMs: sourceStat.mtimeMs,
        targetSize: targetStat.size,
        targetMtimeMs: targetStat.mtimeMs
      },
      null,
      2
    )}\n`,
    'utf-8'
  )
}

beforeEach(() => {
  fsMockState.failLink = false
  fsMockState.failSymlink = false
  fsMockState.failReplacementInstall = false
  fsMockState.afterReplacementCopy = null
  fsMockState.afterFailedSourceLink = null
  fsMockState.beforePreservedRestoreLink = null
  fsMockState.fakeSymlinks.clear()
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-codex-session-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-session-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
  mkdirSync(getSystemCodexHomePath(), { recursive: true })
})

afterEach(() => {
  rmSync(fakeHomeDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

describe('syncSystemCodexSessionsIntoManagedHome', () => {
  it('bridges system Codex session jsonl files into the managed runtime home', () => {
    const systemSessionPath = join(
      getSystemCodexHomePath(),
      'sessions',
      '2026',
      '05',
      '26',
      'rollout-old.jsonl'
    )
    mkdirSync(dirname(systemSessionPath), { recursive: true })
    writeFileSync(systemSessionPath, '{"type":"session_meta","id":"old"}\n', 'utf-8')
    writeFileSync(
      join(getSystemCodexHomePath(), 'sessions', '2026', '05', '26', 'scratch.txt'),
      'not a session\n',
      'utf-8'
    )

    syncSystemCodexSessionsIntoManagedHome()

    const runtimeSessionPath = join(
      getRuntimeCodexHomePath(),
      'sessions',
      '2026',
      '05',
      '26',
      'rollout-old.jsonl'
    )
    expect(readFileSync(runtimeSessionPath, 'utf-8')).toBe('{"type":"session_meta","id":"old"}\n')
    expect(lstatSync(runtimeSessionPath).isSymbolicLink()).toBe(false)
    expectResourceLinked(runtimeSessionPath, systemSessionPath)
    expect(
      existsSync(join(getRuntimeCodexHomePath(), 'sessions', '2026', '05', '26', 'scratch.txt'))
    ).toBe(false)
  })

  it('bridges from a custom source home override instead of ~/.codex', () => {
    // Why: users with a custom CODEX_HOME point history discovery at that
    // folder; the default ~/.codex must be ignored when an override is given.
    const customSourceHome = join(fakeHomeDir, 'custom-codex')
    const customSessionPath = join(
      customSourceHome,
      'sessions',
      '2026',
      '05',
      '26',
      'rollout-custom.jsonl'
    )
    mkdirSync(dirname(customSessionPath), { recursive: true })
    writeFileSync(customSessionPath, '{"id":"custom"}\n', 'utf-8')

    // A session under the default ~/.codex should NOT be bridged when overridden.
    const defaultSessionPath = join(
      getSystemCodexHomePath(),
      'sessions',
      '2026',
      '05',
      '26',
      'rollout-default.jsonl'
    )
    mkdirSync(dirname(defaultSessionPath), { recursive: true })
    writeFileSync(defaultSessionPath, '{"id":"default"}\n', 'utf-8')

    syncSystemCodexSessionsIntoManagedHome(customSourceHome)

    const bridgedCustomPath = join(
      getRuntimeCodexHomePath(),
      'sessions',
      '2026',
      '05',
      '26',
      'rollout-custom.jsonl'
    )
    expect(readFileSync(bridgedCustomPath, 'utf-8')).toBe('{"id":"custom"}\n')
    expect(
      existsSync(
        join(getRuntimeCodexHomePath(), 'sessions', '2026', '05', '26', 'rollout-default.jsonl')
      )
    ).toBe(false)
  })

  it('falls back to a marked regular-file copy when hardlinks are unavailable', () => {
    fsMockState.failLink = true
    const systemSessionPath = join(
      getSystemCodexHomePath(),
      'sessions',
      '2026',
      '05',
      '26',
      'rollout-copy-fallback.jsonl'
    )
    mkdirSync(dirname(systemSessionPath), { recursive: true })
    writeFileSync(systemSessionPath, '{"id":"system"}\n', 'utf-8')

    syncSystemCodexSessionsIntoManagedHome()

    const runtimeSessionPath = join(
      getRuntimeCodexHomePath(),
      'sessions',
      '2026',
      '05',
      '26',
      'rollout-copy-fallback.jsonl'
    )
    expect(lstatSync(runtimeSessionPath).isSymbolicLink()).toBe(false)
    expect(lstatSync(runtimeSessionPath).ino).not.toBe(lstatSync(systemSessionPath).ino)
    expect(readFileSync(runtimeSessionPath, 'utf-8')).toBe('{"id":"system"}\n')
    const markerPath = join(
      getRuntimeCodexHomePath(),
      '.orca-session-copies',
      '2026',
      '05',
      '26',
      'rollout-copy-fallback.jsonl.json'
    )
    expect(existsSync(markerPath)).toBe(true)
    expect(JSON.parse(readFileSync(markerPath, 'utf-8'))).toMatchObject({
      version: 2,
      mtimePrecision: 'milliseconds',
      targetFingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
  })

  it('never overwrites a target that appears during initial copy fallback', () => {
    fsMockState.failLink = true
    const relativeSessionPath = join('2026', '05', '26', 'rollout-copy-race-new.jsonl')
    const systemSessionPath = join(getSystemCodexHomePath(), 'sessions', relativeSessionPath)
    const runtimeSessionPath = join(getRuntimeCodexHomePath(), 'sessions', relativeSessionPath)
    mkdirSync(dirname(systemSessionPath), { recursive: true })
    writeFileSync(systemSessionPath, '{"id":"source"}\n', 'utf-8')
    fsMockState.afterFailedSourceLink = () => {
      mkdirSync(dirname(runtimeSessionPath), { recursive: true })
      writeFileSync(runtimeSessionPath, '{"id":"concurrent"}\n', 'utf-8')
    }

    syncSystemCodexSessionsIntoManagedHome()

    expect(readFileSync(runtimeSessionPath, 'utf-8')).toBe('{"id":"concurrent"}\n')
  })

  it('copies an existing symlink bridge when hardlink replacement is unavailable', () => {
    const relativeSessionPath = join('sessions', '2026', '05', '26', 'rollout-symlink-copy.jsonl')
    const systemSessionPath = join(getSystemCodexHomePath(), relativeSessionPath)
    const runtimeSessionPath = join(getRuntimeCodexHomePath(), relativeSessionPath)
    mkdirSync(dirname(systemSessionPath), { recursive: true })
    mkdirSync(dirname(runtimeSessionPath), { recursive: true })
    writeFileSync(systemSessionPath, '{"id":"system"}\n', 'utf-8')
    symlinkSync(
      systemSessionPath,
      runtimeSessionPath,
      process.platform === 'win32' ? 'file' : undefined
    )
    fsMockState.failLink = true

    syncSystemCodexSessionsIntoManagedHome()

    expect(lstatSync(runtimeSessionPath).isSymbolicLink()).toBe(false)
    expect(readFileSync(runtimeSessionPath, 'utf-8')).toBe('{"id":"system"}\n')
  })

  it('does not overwrite runtime-owned session files', () => {
    const relativeSessionPath = join('sessions', '2026', '05', '26', 'rollout-conflict.jsonl')
    const systemSessionPath = join(getSystemCodexHomePath(), relativeSessionPath)
    const runtimeSessionPath = join(getRuntimeCodexHomePath(), relativeSessionPath)
    mkdirSync(dirname(systemSessionPath), { recursive: true })
    mkdirSync(dirname(runtimeSessionPath), { recursive: true })
    writeFileSync(systemSessionPath, '{"id":"system"}\n', 'utf-8')
    writeFileSync(runtimeSessionPath, '{"id":"runtime"}\n', 'utf-8')

    syncSystemCodexSessionsIntoManagedHome()

    expect(readFileSync(runtimeSessionPath, 'utf-8')).toBe('{"id":"runtime"}\n')
  })

  it('replaces existing symlink bridges with hardlinks', () => {
    const relativeSessionPath = join('sessions', '2026', '05', '26', 'rollout-symlink.jsonl')
    const systemSessionPath = join(getSystemCodexHomePath(), relativeSessionPath)
    const runtimeSessionPath = join(getRuntimeCodexHomePath(), relativeSessionPath)
    mkdirSync(dirname(systemSessionPath), { recursive: true })
    mkdirSync(dirname(runtimeSessionPath), { recursive: true })
    writeFileSync(systemSessionPath, '{"id":"system"}\n', 'utf-8')
    symlinkSync(
      systemSessionPath,
      runtimeSessionPath,
      process.platform === 'win32' ? 'file' : undefined
    )

    syncSystemCodexSessionsIntoManagedHome()

    expect(lstatSync(runtimeSessionPath).isSymbolicLink()).toBe(false)
    expectResourceLinked(runtimeSessionPath, systemSessionPath)
  })

  it('bridges cold-compressed .jsonl.zst session files', () => {
    const systemSessionPath = join(
      getSystemCodexHomePath(),
      'sessions',
      '2026',
      '05',
      '26',
      'rollout-cold.jsonl.zst'
    )
    mkdirSync(dirname(systemSessionPath), { recursive: true })
    writeFileSync(systemSessionPath, 'fake-zstd-bytes', 'utf-8')

    syncSystemCodexSessionsIntoManagedHome()

    const runtimeSessionPath = join(
      getRuntimeCodexHomePath(),
      'sessions',
      '2026',
      '05',
      '26',
      'rollout-cold.jsonl.zst'
    )
    expect(readFileSync(runtimeSessionPath, 'utf-8')).toBe('fake-zstd-bytes')
    expectResourceLinked(runtimeSessionPath, systemSessionPath)
  })

  it('replaces unchanged legacy copied sessions with links', () => {
    const relativeSessionPath = join('2026', '05', '26', 'rollout-legacy.jsonl')
    const systemSessionPath = join(getSystemCodexHomePath(), 'sessions', relativeSessionPath)
    const runtimeSessionPath = join(getRuntimeCodexHomePath(), 'sessions', relativeSessionPath)
    mkdirSync(dirname(systemSessionPath), { recursive: true })
    mkdirSync(dirname(runtimeSessionPath), { recursive: true })
    writeFileSync(systemSessionPath, '{"id":"legacy"}\n', 'utf-8')
    writeFileSync(runtimeSessionPath, '{"id":"legacy"}\n', 'utf-8')
    writeLegacyCopyMarker(relativeSessionPath, systemSessionPath, runtimeSessionPath)

    syncSystemCodexSessionsIntoManagedHome()

    expect(readFileSync(runtimeSessionPath, 'utf-8')).toBe('{"id":"legacy"}\n')
    expectResourceLinked(runtimeSessionPath, systemSessionPath)
    expect(readFileSync(getPreservedSessionPath(relativeSessionPath), 'utf-8')).toBe(
      '{"id":"legacy"}\n'
    )
    expect(existsSync(getPreservedSessionRecordPath(relativeSessionPath))).toBe(true)
  })

  it('preserves unchanged copied sessions when hardlink migration fails', () => {
    const relativeSessionPath = join('2026', '05', '26', 'rollout-legacy-unlinked.jsonl')
    const systemSessionPath = join(getSystemCodexHomePath(), 'sessions', relativeSessionPath)
    const runtimeSessionPath = join(getRuntimeCodexHomePath(), 'sessions', relativeSessionPath)
    mkdirSync(dirname(systemSessionPath), { recursive: true })
    mkdirSync(dirname(runtimeSessionPath), { recursive: true })
    writeFileSync(systemSessionPath, '{"id":"legacy"}\n', 'utf-8')
    writeFileSync(runtimeSessionPath, '{"id":"legacy"}\n', 'utf-8')
    writeLegacyCopyMarker(relativeSessionPath, systemSessionPath, runtimeSessionPath)
    fsMockState.failLink = true

    syncSystemCodexSessionsIntoManagedHome()

    expect(lstatSync(runtimeSessionPath).isSymbolicLink()).toBe(false)
    expect(readFileSync(runtimeSessionPath, 'utf-8')).toBe('{"id":"legacy"}\n')
  })

  it('refreshes an unchanged copy when its source appends', () => {
    fsMockState.failLink = true
    const relativeSessionPath = join('2026', '05', '26', 'rollout-copy-append.jsonl')
    const systemSessionPath = join(getSystemCodexHomePath(), 'sessions', relativeSessionPath)
    const runtimeSessionPath = join(getRuntimeCodexHomePath(), 'sessions', relativeSessionPath)
    mkdirSync(dirname(systemSessionPath), { recursive: true })
    writeFileSync(systemSessionPath, '{"id":"line-1"}\n', 'utf-8')

    syncSystemCodexSessionsIntoManagedHome()
    writeFileSync(systemSessionPath, '{"id":"line-1"}\n{"id":"line-2"}\n', 'utf-8')
    syncSystemCodexSessionsIntoManagedHome()

    expect(lstatSync(runtimeSessionPath).isSymbolicLink()).toBe(false)
    expect(readFileSync(runtimeSessionPath, 'utf-8')).toBe('{"id":"line-1"}\n{"id":"line-2"}\n')
    expect(readFileSync(getPreservedSessionPath(relativeSessionPath), 'utf-8')).toBe(
      '{"id":"line-1"}\n'
    )
  })

  it('preserves late writes through an already-open target descriptor', () => {
    fsMockState.failLink = true
    const relativeSessionPath = join('2026', '05', '26', 'rollout-copy-late-write.jsonl')
    const systemSessionPath = join(getSystemCodexHomePath(), 'sessions', relativeSessionPath)
    const runtimeSessionPath = join(getRuntimeCodexHomePath(), 'sessions', relativeSessionPath)
    mkdirSync(dirname(systemSessionPath), { recursive: true })
    writeFileSync(systemSessionPath, '{"id":"line-1"}\n', 'utf-8')
    syncSystemCodexSessionsIntoManagedHome()

    const descriptor = openSync(runtimeSessionPath, 'a')
    writeFileSync(systemSessionPath, '{"id":"line-1"}\n{"id":"line-2"}\n', 'utf-8')
    syncSystemCodexSessionsIntoManagedHome()
    writeSync(descriptor, '{"id":"late-target-write"}\n')
    closeSync(descriptor)

    expect(readFileSync(runtimeSessionPath, 'utf-8')).toBe('{"id":"line-1"}\n{"id":"line-2"}\n')
    expect(readFileSync(getPreservedSessionPath(relativeSessionPath), 'utf-8')).toBe(
      '{"id":"line-1"}\n{"id":"late-target-write"}\n'
    )
  })

  it('refuses further automatic refresh after preserving one target inode', () => {
    fsMockState.failLink = true
    const relativeSessionPath = join('2026', '05', '26', 'rollout-copy-bounded.jsonl')
    const systemSessionPath = join(getSystemCodexHomePath(), 'sessions', relativeSessionPath)
    const runtimeSessionPath = join(getRuntimeCodexHomePath(), 'sessions', relativeSessionPath)
    mkdirSync(dirname(systemSessionPath), { recursive: true })
    writeFileSync(systemSessionPath, 'one\n', 'utf-8')
    syncSystemCodexSessionsIntoManagedHome()
    writeFileSync(systemSessionPath, 'one\ntwo\n', 'utf-8')
    syncSystemCodexSessionsIntoManagedHome()
    writeFileSync(systemSessionPath, 'one\ntwo\nthree\n', 'utf-8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    syncSystemCodexSessionsIntoManagedHome()

    expect(readFileSync(runtimeSessionPath, 'utf-8')).toBe('one\ntwo\n')
    expect(readFileSync(getPreservedSessionPath(relativeSessionPath), 'utf-8')).toBe('one\n')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('preserved copy requires review'),
      expect.any(String)
    )
  })

  it('does not overwrite a managed copy that diverged after the bridge marker', () => {
    fsMockState.failLink = true
    const relativeSessionPath = join('2026', '05', '26', 'rollout-copy-diverged.jsonl')
    const systemSessionPath = join(getSystemCodexHomePath(), 'sessions', relativeSessionPath)
    const runtimeSessionPath = join(getRuntimeCodexHomePath(), 'sessions', relativeSessionPath)
    mkdirSync(dirname(systemSessionPath), { recursive: true })
    writeFileSync(systemSessionPath, '{"id":"source-1"}\n', 'utf-8')

    syncSystemCodexSessionsIntoManagedHome()
    // Same byte length as the original source and written in the same second:
    // local markers must still use millisecond precision to detect divergence.
    writeFileSync(runtimeSessionPath, '{"id":"target-1"}\n', 'utf-8')
    writeFileSync(systemSessionPath, '{"id":"source-1"}\n{"id":"source-2"}\n', 'utf-8')
    syncSystemCodexSessionsIntoManagedHome()

    expect(readFileSync(runtimeSessionPath, 'utf-8')).toBe('{"id":"target-1"}\n')
  })

  it('revalidates a managed copy after preparing its replacement', () => {
    fsMockState.failLink = true
    const relativeSessionPath = join('2026', '05', '26', 'rollout-copy-race.jsonl')
    const systemSessionPath = join(getSystemCodexHomePath(), 'sessions', relativeSessionPath)
    const runtimeSessionPath = join(getRuntimeCodexHomePath(), 'sessions', relativeSessionPath)
    mkdirSync(dirname(systemSessionPath), { recursive: true })
    writeFileSync(systemSessionPath, '{"id":"source-1"}\n', 'utf-8')
    syncSystemCodexSessionsIntoManagedHome()

    writeFileSync(systemSessionPath, '{"id":"source-1"}\n{"id":"source-2"}\n', 'utf-8')
    fsMockState.afterReplacementCopy = () => {
      writeFileSync(runtimeSessionPath, '{"id":"target-raced"}\n', 'utf-8')
    }
    syncSystemCodexSessionsIntoManagedHome()

    expect(readFileSync(runtimeSessionPath, 'utf-8')).toBe('{"id":"target-raced"}\n')
  })

  it('rolls back the original managed copy when replacement install fails', () => {
    fsMockState.failLink = true
    const relativeSessionPath = join('2026', '05', '26', 'rollout-copy-rollback.jsonl')
    const systemSessionPath = join(getSystemCodexHomePath(), 'sessions', relativeSessionPath)
    const runtimeSessionPath = join(getRuntimeCodexHomePath(), 'sessions', relativeSessionPath)
    mkdirSync(dirname(systemSessionPath), { recursive: true })
    writeFileSync(systemSessionPath, '{"id":"source-1"}\n', 'utf-8')
    syncSystemCodexSessionsIntoManagedHome()

    writeFileSync(systemSessionPath, '{"id":"source-1"}\n{"id":"source-2"}\n', 'utf-8')
    fsMockState.failReplacementInstall = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    syncSystemCodexSessionsIntoManagedHome()

    expect(readFileSync(runtimeSessionPath, 'utf-8')).toBe('{"id":"source-1"}\n')
    expect(readFileSync(getPreservedSessionPath(relativeSessionPath), 'utf-8')).toBe(
      '{"id":"source-1"}\n'
    )
    expect(existsSync(getPreservedSessionRecordPath(relativeSessionPath))).toBe(true)
    expect(warn).toHaveBeenCalled()
  })

  it('never overwrites a target that appears during exclusive preserved restore', () => {
    fsMockState.failLink = true
    const relativeSessionPath = join('2026', '05', '26', 'rollout-restore-race.jsonl')
    const systemSessionPath = join(getSystemCodexHomePath(), 'sessions', relativeSessionPath)
    const runtimeSessionPath = join(getRuntimeCodexHomePath(), 'sessions', relativeSessionPath)
    mkdirSync(dirname(systemSessionPath), { recursive: true })
    writeFileSync(systemSessionPath, 'source-one\n', 'utf-8')
    syncSystemCodexSessionsIntoManagedHome()
    writeFileSync(systemSessionPath, 'source-one\nsource-two\n', 'utf-8')
    fsMockState.failReplacementInstall = true
    fsMockState.beforePreservedRestoreLink = () => {
      writeFileSync(runtimeSessionPath, 'concurrent-target\n', 'utf-8')
    }
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    syncSystemCodexSessionsIntoManagedHome()

    expect(readFileSync(runtimeSessionPath, 'utf-8')).toBe('concurrent-target\n')
    expect(readFileSync(getPreservedSessionPath(relativeSessionPath), 'utf-8')).toBe(
      'source-one\n'
    )
  })

  it('incrementally bridges session files without requiring the synchronous launch path', async () => {
    const systemSessionRoot = join(getSystemCodexHomePath(), 'sessions', '2026', '06', '18')
    mkdirSync(systemSessionRoot, { recursive: true })
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(
        join(systemSessionRoot, `rollout-incremental-${index}.jsonl`),
        `{"id":"incremental-${index}"}\n`,
        'utf-8'
      )
    }

    const summary = await syncSystemCodexSessionsIntoManagedHomeIncrementally({
      batchSize: 2,
      yieldMs: 0
    })

    expect(summary).toEqual({ scannedFiles: 5, linkedFiles: 5 })
    for (let index = 0; index < 5; index += 1) {
      const systemSessionPath = join(systemSessionRoot, `rollout-incremental-${index}.jsonl`)
      const runtimeSessionPath = join(
        getRuntimeCodexHomePath(),
        'sessions',
        '2026',
        '06',
        '18',
        `rollout-incremental-${index}.jsonl`
      )
      expectResourceLinked(runtimeSessionPath, systemSessionPath)
    }
  })
})
