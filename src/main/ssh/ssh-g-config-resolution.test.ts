import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { buildSshGArgs } from './ssh-g-config-resolution'
import { setSshConfigFilePathOverride } from './ssh-config-file-path'

// Why: resolveSshConfigHomePath imports from 'node:os'; mock the exact specifier
// so ~-expansion assertions don't rely on Vitest normalizing 'os' ↔ 'node:os'.
vi.mock('node:os', () => ({
  homedir: () => '/home/testuser'
}))

const TEST_HOME = '/home/testuser'

afterEach(() => {
  setSshConfigFilePathOverride(undefined)
})

describe('buildSshGArgs', () => {
  it('omits -F when no override is set', () => {
    expect(buildSshGArgs('workbox')).toEqual(['-G', '--', 'workbox'])
  })

  it('adds -F with the override path when set (module holder)', () => {
    setSshConfigFilePathOverride('/etc/ssh/custom_config')
    expect(buildSshGArgs('workbox')).toEqual([
      '-G',
      '-F',
      '/etc/ssh/custom_config',
      '--',
      'workbox'
    ])
  })

  it('expands a ~-prefixed override path passed explicitly', () => {
    expect(buildSshGArgs('workbox', '~/work/ssh_config')).toEqual([
      '-G',
      '-F',
      join(TEST_HOME, 'work', 'ssh_config'),
      '--',
      'workbox'
    ])
  })
})
