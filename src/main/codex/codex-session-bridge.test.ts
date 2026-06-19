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
  fsMockState: { failLink: false, failSymlink: false }
}))

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
    symlinkSync: (...args: Parameters<typeof actual.symlinkSync>) => {
      if (fsMockState.failSymlink) {
        throw new Error('symlink disabled for test')
      }
      return actual.symlinkSync(...args)
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

import { syncSystemCodexSessionsIntoManagedHome } from './codex-session-bridge'

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
})
