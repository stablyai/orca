import { describe, expect, it, vi } from 'vitest'
import {
  parseWslDistroRegistrations,
  readWslDistroRegistryId,
  readWslDistroRegistryIdShared,
  resetWslDistroRegistryIdSharedReadsForTests
} from './wsl-distro-registry-id'

const LXSS = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'
const REG_OUTPUT = [
  '',
  `${LXSS}\\{0283592D-BE56-40D4-B935-3DC18C3AA007}`,
  '    DistributionName    REG_SZ    Ubuntu-24.04',
  '',
  `${LXSS}\\{1b2c3d4e-0000-4000-8000-000000000001}`,
  '    DistributionName    REG_SZ    docker-desktop',
  '',
  // Localized footer: matched by shape, never by text.
  'Fin de la recherche : 2 correspondance(s) trouvée(s).',
  ''
].join('\r\n')

describe('the distro registration GUID', () => {
  it('pairs each braced Lxss subkey with its DistributionName, as a lowercase unbraced GUID', () => {
    expect(parseWslDistroRegistrations(REG_OUTPUT)).toEqual([
      { id: '0283592d-be56-40d4-b935-3dc18c3aa007', distro: 'Ubuntu-24.04', version: null },
      { id: '1b2c3d4e-0000-4000-8000-000000000001', distro: 'docker-desktop', version: null }
    ])
  })

  it('reads each registration’s WSL version from a full /s listing', () => {
    const output = [
      `${LXSS}\\{0283592D-BE56-40D4-B935-3DC18C3AA007}`,
      '    State    REG_DWORD    0x1',
      '    DistributionName    REG_SZ    Ubuntu',
      '    Version    REG_DWORD    0x2',
      `${LXSS}\\{1B2C3D4E-0000-4000-8000-000000000001}`,
      '    DistributionName    REG_SZ    Legacy',
      '    Version    REG_DWORD    0x1'
    ].join('\r\n')
    expect(parseWslDistroRegistrations(output)).toEqual([
      { id: '0283592d-be56-40d4-b935-3dc18c3aa007', distro: 'Ubuntu', version: 2 },
      { id: '1b2c3d4e-0000-4000-8000-000000000001', distro: 'Legacy', version: 1 }
    ])
  })

  it('reads it through one reg.exe query, matching the name case-insensitively', async () => {
    const query = vi.fn(async () => ({ code: 0, stdout: REG_OUTPUT }))
    await expect(readWslDistroRegistryId('ubuntu-24.04', query)).resolves.toBe(
      '0283592d-be56-40d4-b935-3dc18c3aa007'
    )
    expect(query).toHaveBeenCalledWith([
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss',
      '/s'
    ])
  })

  it('answers null for an unknown distro, a failed query or a thrown spawn', async () => {
    await expect(
      readWslDistroRegistryId('Debian', async () => ({ code: 0, stdout: REG_OUTPUT }))
    ).resolves.toBeNull()
    await expect(
      readWslDistroRegistryId('Ubuntu-24.04', async () => ({ code: 1, stdout: '' }))
    ).resolves.toBeNull()
    await expect(
      readWslDistroRegistryId('Ubuntu-24.04', async () => {
        throw new Error('ENOENT')
      })
    ).resolves.toBeNull()
  })
})

describe('readWslDistroRegistryIdShared', () => {
  it('reads the registry once per deploy window, case-insensitively, then again after it', async () => {
    resetWslDistroRegistryIdSharedReadsForTests()
    let reads = 0
    const read = async () => `guid-${++reads}`
    let clock = 0
    const now = () => clock
    expect(await readWslDistroRegistryIdShared('Ubuntu', now, read)).toBe('guid-1')
    expect(await readWslDistroRegistryIdShared('ubuntu', now, read)).toBe('guid-1')
    clock = 31_000
    expect(await readWslDistroRegistryIdShared('Ubuntu', now, read)).toBe('guid-2')
    expect(reads).toBe(2)
  })
})
