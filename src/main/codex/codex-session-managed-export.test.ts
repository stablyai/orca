import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { exportManagedCodexSessionToSystemHistory } from './codex-session-managed-export'

let fixtureRoot: string
let managedCodexHome: string
let systemCodexHome: string
let previousUserDataPath: string | undefined

function managedSessionPath(fileName: string): string {
  return join(managedCodexHome, 'sessions', '2026', '07', '10', fileName)
}

function systemSessionPath(fileName: string): string {
  return join(systemCodexHome, 'sessions', '2026', '07', '10', fileName)
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'orca-managed-session-export-'))
  const userDataPath = join(fixtureRoot, 'user-data')
  managedCodexHome = join(userDataPath, 'codex-runtime-home', 'home')
  systemCodexHome = join(fixtureRoot, 'system-codex-home')
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataPath
})

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.restoreAllMocks()
})

describe('exportManagedCodexSessionToSystemHistory', () => {
  it('creates one shared log and remains idempotent while either side appends', () => {
    const managedPath = managedSessionPath('rollout-shared.jsonl')
    const systemPath = systemSessionPath('rollout-shared.jsonl')
    mkdirSync(dirname(managedPath), { recursive: true })
    writeFileSync(managedPath, '{"id":"shared"}\n', 'utf-8')

    expect(exportManagedCodexSessionToSystemHistory(managedPath, systemCodexHome)).toBe('linked')
    expect(exportManagedCodexSessionToSystemHistory(managedPath, systemCodexHome)).toBe(
      'already-linked'
    )

    appendFileSync(managedPath, '{"from":"orca"}\n', 'utf-8')
    expect(readFileSync(systemPath, 'utf-8')).toContain('"from":"orca"')
    appendFileSync(systemPath, '{"from":"external"}\n', 'utf-8')
    expect(readFileSync(managedPath, 'utf-8')).toContain('"from":"external"')
  })

  it('preserves independent histories when the relative path collides', () => {
    const managedPath = managedSessionPath('rollout-collision.jsonl')
    const systemPath = systemSessionPath('rollout-collision.jsonl')
    mkdirSync(dirname(managedPath), { recursive: true })
    mkdirSync(dirname(systemPath), { recursive: true })
    writeFileSync(managedPath, '{"id":"managed"}\n', 'utf-8')
    writeFileSync(systemPath, '{"id":"system"}\n', 'utf-8')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(exportManagedCodexSessionToSystemHistory(managedPath, systemCodexHome)).toBe('collision')
    expect(readFileSync(managedPath, 'utf-8')).toBe('{"id":"managed"}\n')
    expect(readFileSync(systemPath, 'utf-8')).toBe('{"id":"system"}\n')
  })

  it('ignores a hook path outside the managed sessions root', () => {
    const outsidePath = join(fixtureRoot, 'outside.jsonl')
    writeFileSync(outsidePath, '{"id":"outside"}\n', 'utf-8')

    expect(exportManagedCodexSessionToSystemHistory(outsidePath, systemCodexHome)).toBe('ignored')
  })

  it.skipIf(process.platform === 'win32')('does not follow a managed transcript symlink', () => {
    const outsidePath = join(fixtureRoot, 'outside.jsonl')
    const managedPath = managedSessionPath('rollout-symlink.jsonl')
    writeFileSync(outsidePath, '{"id":"outside"}\n', 'utf-8')
    mkdirSync(dirname(managedPath), { recursive: true })
    symlinkSync(outsidePath, managedPath)

    expect(exportManagedCodexSessionToSystemHistory(managedPath, systemCodexHome)).toBe('ignored')
  })

  it.skipIf(process.platform === 'win32')('refuses a symlinked system date directory', () => {
    const managedPath = managedSessionPath('rollout-target-symlink.jsonl')
    const outsideDirectory = join(fixtureRoot, 'outside-system-directory')
    mkdirSync(dirname(managedPath), { recursive: true })
    mkdirSync(join(systemCodexHome, 'sessions'), { recursive: true })
    mkdirSync(outsideDirectory)
    symlinkSync(outsideDirectory, join(systemCodexHome, 'sessions', '2026'))
    writeFileSync(managedPath, '{"id":"managed"}\n', 'utf-8')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(exportManagedCodexSessionToSystemHistory(managedPath, systemCodexHome)).toBe('failed')
    expect(readFileSync(managedPath, 'utf-8')).toBe('{"id":"managed"}\n')
  })
})
