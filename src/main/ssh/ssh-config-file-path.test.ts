import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  getSshConfigFileFlagArgs,
  getSshConfigFilePath,
  getSshConfigFilePathOverride,
  setSshConfigFilePathOverride
} from './ssh-config-file-path'

// Why: the module under test (and resolveSshConfigHomePath) import from
// 'node:os'; mock the exact specifier so interception doesn't rely on Vitest
// normalizing 'os' ↔ 'node:os'.
vi.mock('node:os', () => ({
  homedir: () => '/home/testuser'
}))

const TEST_HOME = '/home/testuser'

// Why: the override is module-level state; reset it around each test so cases
// never leak into one another.
beforeEach(() => {
  setSshConfigFilePathOverride(undefined)
})
afterEach(() => {
  setSshConfigFilePathOverride(undefined)
})

describe('ssh-config-file-path override', () => {
  it('defaults to ~/.ssh/config when unset', () => {
    expect(getSshConfigFilePathOverride()).toBeUndefined()
    expect(getSshConfigFilePath()).toBe(join(TEST_HOME, '.ssh', 'config'))
  })

  it('trims surrounding whitespace on the raw override', () => {
    setSshConfigFilePathOverride('  /etc/ssh/custom_config  ')
    expect(getSshConfigFilePathOverride()).toBe('/etc/ssh/custom_config')
    expect(getSshConfigFilePath()).toBe('/etc/ssh/custom_config')
  })

  it('treats empty / whitespace-only as unset', () => {
    setSshConfigFilePathOverride('   ')
    expect(getSshConfigFilePathOverride()).toBeUndefined()
    expect(getSshConfigFilePath()).toBe(join(TEST_HOME, '.ssh', 'config'))

    setSshConfigFilePathOverride('')
    expect(getSshConfigFilePathOverride()).toBeUndefined()
  })

  it('expands a ~-prefixed override path', () => {
    setSshConfigFilePathOverride('~/work/ssh_config')
    expect(getSshConfigFilePath()).toBe(join(TEST_HOME, 'work', 'ssh_config'))
  })
})

describe('getSshConfigFileFlagArgs', () => {
  it('returns [] when no override is set', () => {
    expect(getSshConfigFileFlagArgs()).toEqual([])
  })

  it('returns the -F fragment with the expanded path when overridden', () => {
    setSshConfigFilePathOverride('~/work/ssh_config')
    expect(getSshConfigFileFlagArgs()).toEqual(['-F', join(TEST_HOME, 'work', 'ssh_config')])
  })

  it('honors an explicitly passed override argument', () => {
    expect(getSshConfigFileFlagArgs('/etc/ssh/custom_config')).toEqual([
      '-F',
      '/etc/ssh/custom_config'
    ])
    expect(getSshConfigFileFlagArgs(undefined)).toEqual([])
  })
})
