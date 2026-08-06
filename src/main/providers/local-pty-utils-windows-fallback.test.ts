import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as pty from 'node-pty'
import { spawnShellWithFallback, type WindowsShellSpawnAttempt } from './local-pty-utils'

function setPlatform(platform: NodeJS.Platform): () => void {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  return () => Object.defineProperty(process, 'platform', { configurable: true, value: original })
}

let restorePlatform: (() => void) | null = null
afterEach(() => {
  restorePlatform?.()
  restorePlatform = null
  vi.restoreAllMocks()
})

const PWSH7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CMD = 'C:\\Windows\\System32\\cmd.exe'

function makeFakePty(): pty.IPty {
  return { pid: 1234 } as unknown as pty.IPty
}

function makeAttempt(
  shellPath: string,
  overrides: Partial<WindowsShellSpawnAttempt> = {}
): WindowsShellSpawnAttempt {
  return {
    shellPath,
    shellArgs: ['-NoLogo'],
    effectiveCwd: 'C:\\repo',
    validationCwd: 'C:\\repo',
    startupCommandDeliveredInShellArgs: false,
    ...overrides
  }
}

// error code 5 == ERROR_ACCESS_DENIED from CreateProcessW inside ConPTY when a
// bare/alias pwsh.exe is handed to node-pty.
const ACCESS_DENIED_5 = 'Cannot create process, error code: 5'

describe('spawnShellWithFallback on Windows', () => {
  it('repro: recovers when the primary PowerShell spawn fails with error code 5', () => {
    restorePlatform = setPlatform('win32')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const attempts: WindowsShellSpawnAttempt[] = [
      makeAttempt(PWSH7),
      makeAttempt(WINDOWS_POWERSHELL),
      makeAttempt(CMD, { shellArgs: ['/K', 'chcp 65001 > nul'] })
    ]

    const ptySpawn = vi.fn((shellPath: string) => {
      if (shellPath === PWSH7) {
        throw new Error(ACCESS_DENIED_5)
      }
      return makeFakePty()
    }) as unknown as typeof pty.spawn

    const result = spawnShellWithFallback({
      shellPath: PWSH7,
      shellArgs: attempts[0].shellArgs,
      cols: 80,
      rows: 24,
      cwd: 'C:\\repo',
      env: {},
      ptySpawn,
      windowsFallbackAttempts: attempts
    })

    // Falls back to the next real absolute executable instead of throwing.
    expect(result.shellPath).toBe(WINDOWS_POWERSHELL)
    expect(ptySpawn).toHaveBeenNthCalledWith(
      1,
      PWSH7,
      attempts[0].shellArgs,
      expect.objectContaining({ cwd: 'C:\\repo', useConptyDll: true })
    )
    expect(ptySpawn).toHaveBeenNthCalledWith(
      2,
      WINDOWS_POWERSHELL,
      attempts[1].shellArgs,
      expect.objectContaining({ cwd: 'C:\\repo', useConptyDll: true })
    )
  })

  it('falls all the way through to cmd.exe and surfaces its argv-delivery flag', () => {
    restorePlatform = setPlatform('win32')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const attempts: WindowsShellSpawnAttempt[] = [
      makeAttempt(PWSH7),
      makeAttempt(WINDOWS_POWERSHELL),
      makeAttempt(CMD, {
        shellArgs: ['/K', 'chcp 65001 > nul & npm start'],
        startupCommandDeliveredInShellArgs: true
      })
    ]

    const ptySpawn = vi.fn((shellPath: string) => {
      if (shellPath === CMD) {
        return makeFakePty()
      }
      throw new Error(ACCESS_DENIED_5)
    }) as unknown as typeof pty.spawn

    const result = spawnShellWithFallback({
      shellPath: PWSH7,
      shellArgs: attempts[0].shellArgs,
      cols: 80,
      rows: 24,
      cwd: 'C:\\repo',
      env: {},
      ptySpawn,
      windowsFallbackAttempts: attempts
    })

    expect(result.shellPath).toBe(CMD)
    expect(result.startupCommandDeliveredInShellArgs).toBe(true)
  })

  it('throws a descriptive error when every Windows fallback fails', () => {
    restorePlatform = setPlatform('win32')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const attempts: WindowsShellSpawnAttempt[] = [
      makeAttempt(PWSH7),
      makeAttempt(WINDOWS_POWERSHELL),
      makeAttempt(CMD)
    ]
    const ptySpawn = vi.fn(() => {
      throw new Error(ACCESS_DENIED_5)
    }) as unknown as typeof pty.spawn

    expect(() =>
      spawnShellWithFallback({
        shellPath: PWSH7,
        shellArgs: attempts[0].shellArgs,
        cols: 80,
        rows: 24,
        cwd: 'C:\\repo',
        env: {},
        ptySpawn,
        windowsFallbackAttempts: attempts
      })
    ).toThrow(/Failed to spawn shell/)
  })
})
