import { describe, expect, it } from 'vitest'
import { lockedVersion, lockfileRootImporter } from './pnpm-lockfile-root-importer.mjs'

describe('lockfileRootImporter', () => {
  it('merges the root importer across pnpm 12 lockfile documents', () => {
    const contents = [
      '---',
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    packageManagerDependencies: {}',
      '---',
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    devDependencies:',
      '      electron:',
      '        specifier: 43.7.5',
      '        version: 43.7.5(supports-color@7.2.0)',
      ''
    ].join('\n')
    expect(lockfileRootImporter(contents).devDependencies.electron.version).toBe(
      '43.7.5(supports-color@7.2.0)'
    )
  })
})

describe('lockedVersion', () => {
  it('strips the peer suffix from an entry or a bare string', () => {
    expect(lockedVersion({ version: '4.6.7(typescript@6.0.3)' })).toBe('4.6.7')
    expect(lockedVersion('8.22.0(patch_hash=abc)')).toBe('8.22.0')
    expect(lockedVersion(undefined)).toBeNull()
  })
})
