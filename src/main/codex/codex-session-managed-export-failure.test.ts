import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const { linkFailureState } = vi.hoisted(() => ({
  linkFailureState: {
    code: 'EXDEV',
    linkThenThrow: false
  }
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    linkSync: (sourcePath: NodeFs.PathLike, targetPath: NodeFs.PathLike) => {
      if (linkFailureState.linkThenThrow) {
        actual.linkSync(sourcePath, targetPath)
      }
      const error = new Error(`synthetic ${linkFailureState.code}`) as NodeJS.ErrnoException
      error.code = linkFailureState.code
      throw error
    }
  }
})

import { exportManagedCodexSessionToSystemHistory } from './codex-session-managed-export'

let fixtureRoot: string
let managedSessionPath: string
let systemCodexHome: string
let systemSessionPath: string
let previousUserDataPath: string | undefined

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'orca-managed-session-link-failure-'))
  const userDataPath = join(fixtureRoot, 'user-data')
  managedSessionPath = join(
    userDataPath,
    'codex-runtime-home',
    'home',
    'sessions',
    '2026',
    '07',
    '10',
    'rollout-orca.jsonl'
  )
  systemCodexHome = join(fixtureRoot, 'system-codex-home')
  systemSessionPath = join(systemCodexHome, 'sessions', '2026', '07', '10', 'rollout-orca.jsonl')
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataPath
  linkFailureState.code = 'EXDEV'
  linkFailureState.linkThenThrow = false
  mkdirSync(dirname(managedSessionPath), { recursive: true })
  writeFileSync(managedSessionPath, '{"id":"managed"}\n', 'utf-8')
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
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

describe('managed Codex session hardlink failures', () => {
  it.each(['EXDEV', 'EPERM'])('preserves the managed log when link fails with %s', (code) => {
    linkFailureState.code = code

    expect(exportManagedCodexSessionToSystemHistory(managedSessionPath, systemCodexHome)).toBe(
      'failed'
    )
    expect(readFileSync(managedSessionPath, 'utf-8')).toBe('{"id":"managed"}\n')
    expect(existsSync(systemSessionPath)).toBe(false)
  })

  it('accepts a concurrent winner that creates the same hardlink', () => {
    linkFailureState.code = 'EEXIST'
    linkFailureState.linkThenThrow = true

    expect(exportManagedCodexSessionToSystemHistory(managedSessionPath, systemCodexHome)).toBe(
      'already-linked'
    )
    expect(readFileSync(systemSessionPath, 'utf-8')).toBe('{"id":"managed"}\n')
  })
})
