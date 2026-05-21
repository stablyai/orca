import { describe, expect, it } from 'vitest'
import { isHostCodexHomeForWsl } from './codex-home-wsl-env'

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
})
