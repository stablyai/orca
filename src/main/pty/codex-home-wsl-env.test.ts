import { describe, expect, it } from 'vitest'
import { isHostCodexHomeForWsl, isWslCodexHomeForHost } from './codex-home-wsl-env'

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
})
