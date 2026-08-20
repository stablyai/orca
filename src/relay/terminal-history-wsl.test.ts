import { describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type * as NodeOs from 'node:os'
import { hashWorktreeId } from '../main/terminal-history-id'

// Why mocked rather than a real temp dir: the assertion is the Windows -> Linux
// path conversion, which only happens for a drive-letter root that cannot exist
// on the macOS/Linux runners this suite executes on.
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => 'C:\\Users\\relay'
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const dirStat = { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false }
  const fileStat = {
    isSymbolicLink: () => false,
    isDirectory: () => false,
    isFile: () => true,
    dev: 1n,
    ino: 2n
  }
  return {
    ...actual,
    constants: actual.constants,
    mkdirSync: vi.fn(),
    lstatSync: vi.fn((path: string) => (path.endsWith('terminal-history') ? dirStat : fileStat)),
    openSync: vi.fn(() => 42),
    fstatSync: vi.fn(() => fileStat),
    closeSync: vi.fn(),
    unlinkSync: vi.fn()
  }
})

const worktreeId = 'relay-wsl::/remote/worktree'

// Why compare on one separator: the fixture home is a Windows path and
// production joins it with the host separator, so the expectation is mixed on
// POSIX and all-backslash on Windows. What these cases pin is the /mnt/c
// translation handed to the guest, not which slash the host side uses.
const sameHostPath = (value: string | null): string | null =>
  value === null ? null : value.split('\\').join('/')

describe('relay WSL shell history', () => {
  it('hands the guest a drvfs path for the host history file', async () => {
    const { injectRelayHistoryEnv } = await import('./terminal-history')
    const env: Record<string, string> = {}

    const root = injectRelayHistoryEnv(env, worktreeId, 'C:\\Windows\\System32\\wsl.exe', {
      wsl: true
    })

    expect(sameHostPath(root)).toBe('C:/Users/relay/.orca-remote/terminal-history')
    expect(env.HISTFILE).toBe(
      `/mnt/c/Users/relay/.orca-remote/terminal-history/${hashWorktreeId(worktreeId)}-bash_history`
    )
    expect(env.ORCA_HISTFILE).toBe(env.HISTFILE)
  })

  it('leaves a host shell on the untranslated host path', async () => {
    const { injectRelayHistoryEnv } = await import('./terminal-history')
    const env: Record<string, string> = {}

    injectRelayHistoryEnv(env, worktreeId, '/bin/bash')

    expect(sameHostPath(env.HISTFILE)).toBe(
      `C:/Users/relay/.orca-remote/terminal-history/${hashWorktreeId(worktreeId)}-bash_history`
    )
  })

  it('scopes nothing for wsl.exe when the caller does not flag it as WSL', async () => {
    const { injectRelayHistoryEnv } = await import('./terminal-history')
    const env: Record<string, string> = {}

    expect(injectRelayHistoryEnv(env, worktreeId, 'wsl.exe')).toBeNull()
    expect(env.HISTFILE).toBeUndefined()
  })
})
