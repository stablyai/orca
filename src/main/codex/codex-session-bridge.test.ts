import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
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
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      if (fsMockState.failLink) {
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

  it('falls back to symlinks when hardlinks are unavailable', () => {
    fsMockState.failLink = true
    const systemSessionPath = join(
      getSystemCodexHomePath(),
      'sessions',
      '2026',
      '05',
      '26',
      'rollout-symlink-fallback.jsonl'
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
      'rollout-symlink-fallback.jsonl'
    )
    expect(lstatSync(runtimeSessionPath).isSymbolicLink()).toBe(true)
    expect(normalizeLinkTarget(readlinkSync(runtimeSessionPath))).toBe(
      normalizeLinkTarget(systemSessionPath)
    )
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

  it('does not create independent session copies when file links are unavailable', () => {
    fsMockState.failLink = true
    fsMockState.failSymlink = true
    const systemSessionPath = join(
      getSystemCodexHomePath(),
      'sessions',
      '2026',
      '05',
      '26',
      'rollout-unlinked.jsonl'
    )
    mkdirSync(dirname(systemSessionPath), { recursive: true })
    writeFileSync(systemSessionPath, '{"id":"system"}\n', 'utf-8')

    syncSystemCodexSessionsIntoManagedHome()

    expect(
      existsSync(
        join(getRuntimeCodexHomePath(), 'sessions', '2026', '05', '26', 'rollout-unlinked.jsonl')
      )
    ).toBe(false)
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
  })

  it('preserves unchanged legacy copied sessions when relinking fails', () => {
    const relativeSessionPath = join('2026', '05', '26', 'rollout-legacy-unlinked.jsonl')
    const systemSessionPath = join(getSystemCodexHomePath(), 'sessions', relativeSessionPath)
    const runtimeSessionPath = join(getRuntimeCodexHomePath(), 'sessions', relativeSessionPath)
    mkdirSync(dirname(systemSessionPath), { recursive: true })
    mkdirSync(dirname(runtimeSessionPath), { recursive: true })
    writeFileSync(systemSessionPath, '{"id":"legacy"}\n', 'utf-8')
    writeFileSync(runtimeSessionPath, '{"id":"legacy"}\n', 'utf-8')
    writeLegacyCopyMarker(relativeSessionPath, systemSessionPath, runtimeSessionPath)
    fsMockState.failLink = true
    fsMockState.failSymlink = true

    syncSystemCodexSessionsIntoManagedHome()

    expect(lstatSync(runtimeSessionPath).isSymbolicLink()).toBe(false)
    expect(readFileSync(runtimeSessionPath, 'utf-8')).toBe('{"id":"legacy"}\n')
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
