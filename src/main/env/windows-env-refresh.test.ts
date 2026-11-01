import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearWindowsEnvOverrideCacheForTests,
  expandRegistryEnvValue,
  mergeRegistryEnv,
  parseRegQueryEnvOutput,
  readCurrentWindowsEnvOverrides
} from './windows-env-refresh'

beforeEach(() => {
  clearWindowsEnvOverrideCacheForTests()
})

describe('parseRegQueryEnvOutput', () => {
  it('parses REG_SZ and REG_EXPAND_SZ rows from a real-shaped query', () => {
    const stdout = [
      '',
      'HKEY_CURRENT_USER\\Environment',
      '    ORCA_GITEA_TOKEN    REG_SZ    tok_fresh',
      '    PATH    REG_EXPAND_SZ    C:\\bin;%SystemRoot%\\System32',
      '    TEMP    REG_SZ    %USERPROFILE%\\AppData\\Local\\Temp',
      ''
    ].join('\n')
    expect(parseRegQueryEnvOutput(stdout)).toEqual({
      ORCA_GITEA_TOKEN: 'tok_fresh',
      PATH: 'C:\\bin;%SystemRoot%\\System32',
      TEMP: '%USERPROFILE%\\AppData\\Local\\Temp'
    })
  })

  it('ignores headers, blank lines, and rows of other types', () => {
    const stdout = [
      'HKEY_CURRENT_USER\\Environment',
      '    NUMBER_OF_PROCESSORS    REG_DWORD    0x10',
      '    good    REG_SZ    value'
    ].join('\n')
    expect(parseRegQueryEnvOutput(stdout)).toEqual({ good: 'value' })
  })
})

describe('expandRegistryEnvValue', () => {
  it('expands against the merged view and keeps unknown references literal', () => {
    const merged = { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\a' }
    expect(expandRegistryEnvValue('%SystemRoot%\\System32', merged)).toBe(
      'C:\\Windows\\System32'
    )
    expect(expandRegistryEnvValue('%USERPROFILE%\\Temp;%NOPE%', merged)).toBe(
      'C:\\Users\\a\\Temp;%NOPE%'
    )
  })
})

describe('mergeRegistryEnv', () => {
  it('applies machine then user over the inherited environment (#14740)', () => {
    const merged = mergeRegistryEnv(
      { ORCA_GITEA_TOKEN: 'tok_stale', ORCA_GITEA_API_BASE_URL: 'https://old.example' },
      { MACHINE_VAR: 'm', SHARED: 'from-machine' },
      { ORCA_GITEA_TOKEN: 'tok_fresh', SHARED: 'from-user' }
    )
    // The registry is what the user edited: its rows beat the stale snapshot.
    expect(merged.ORCA_GITEA_TOKEN).toBe('tok_fresh')
    expect(merged.ORCA_GITEA_API_BASE_URL).toBe('https://old.example')
    expect(merged.SHARED).toBe('from-user')
    expect(merged.MACHINE_VAR).toBe('m')
  })
})

describe('readCurrentWindowsEnvOverrides', () => {
  it('returns {} off Windows and a registry-shaped overlay on Windows', async () => {
    const overrides = await readCurrentWindowsEnvOverrides()
    if (process.platform !== 'win32') {
      expect(overrides).toEqual({})
      return
    }
    // On a real Windows host the user Environment key exists and carries at
    // least TEMP/TMP or user-set rows; values must be plain (expanded) strings.
    for (const [name, value] of Object.entries(overrides)) {
      expect(typeof name).toBe('string')
      expect(typeof value).toBe('string')
    }
    expect(Object.keys(overrides).length).toBeGreaterThan(0)
  })
})
