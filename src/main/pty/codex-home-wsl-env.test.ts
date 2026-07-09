import { describe, expect, it } from 'vitest'
import {
  getHostCodexHomeStrippedForWslMessage,
  isHostCodexHomeForWsl,
  isWslCodexHomeForHost,
  shouldStripHostCodexHomeForWslShell
} from './codex-home-wsl-env'

describe('isHostCodexHomeForWsl', () => {
  it('matches Windows paths that WSL Codex cannot use as CODEX_HOME', () => {
    expect(isHostCodexHomeForWsl('C:\\Users\\jin\\.codex')).toBe(true)
    expect(isHostCodexHomeForWsl('C:/Users/jin/.codex')).toBe(true)
    expect(isHostCodexHomeForWsl('C:')).toBe(true)
    expect(isHostCodexHomeForWsl('\\\\server\\share\\.codex')).toBe(true)
  })

  it('does not match Linux paths or empty values', () => {
    expect(isHostCodexHomeForWsl('/home/jin/.codex')).toBe(false)
    expect(isHostCodexHomeForWsl('')).toBe(false)
    expect(isHostCodexHomeForWsl(undefined)).toBe(false)
  })

  it('matches Linux paths that host Codex cannot use on Windows', () => {
    expect(isWslCodexHomeForHost('/home/jin/.local/share/orca/codex-accounts/a/home')).toBe(true)
    expect(isWslCodexHomeForHost('C:\\Users\\jin\\.codex')).toBe(false)
    expect(isWslCodexHomeForHost(undefined)).toBe(false)
  })

  it('documents strip behavior when host CODEX_HOME reaches a WSL shell', () => {
    // Why: host-managed account selection must not leak into WSL; callers strip
    // CODEX_HOME so the distro uses Linux ~/.codex or a WSL-managed account.
    expect(shouldStripHostCodexHomeForWslShell('C:\\Users\\jin\\.orca\\codex-accounts\\a\\home')).toBe(
      true
    )
    expect(shouldStripHostCodexHomeForWslShell('/home/jin/.codex')).toBe(false)
    expect(getHostCodexHomeStrippedForWslMessage()).toMatch(/WSL terminals use the distro Codex home/)
    expect(getHostCodexHomeStrippedForWslMessage()).toMatch(/not the host Windows CODEX_HOME/)
  })
})
