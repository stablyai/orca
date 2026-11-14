import { describe, expect, it } from 'vitest'
import {
  parseDefaultWslDistroId,
  parseWslDistroRegistrations,
  readWslDistroRegistryId,
  resolveWslDistroName
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

describe('resolveWslDistroName', () => {
  const query = async () => ({ code: 0, stdout: REG_OUTPUT })

  it('names a renamed distro by its recorded GUID, braced or not', async () => {
    await expect(
      resolveWslDistroName('Ubuntu', '{0283592D-BE56-40D4-B935-3DC18C3AA007}', query)
    ).resolves.toBe('Ubuntu-24.04')
  })

  it('reports a distro gone only when neither its name nor its GUID is registered', async () => {
    await expect(
      resolveWslDistroName('Ubuntu', '99999999-0000-4000-8000-000000000000', query)
    ).resolves.toBe(false)
  })

  it('never reports gone when the registrations cannot be read', async () => {
    await expect(
      resolveWslDistroName('Ubuntu', undefined, async () => ({ code: 1, stdout: '' }))
    ).resolves.toBeNull()
  })
})

describe('the default distro registration', () => {
  it('reads DefaultDistribution from the Lxss root as a lowercase unbraced GUID', () => {
    const output = [
      LXSS,
      '    DefaultDistribution    REG_SZ    {0283592D-BE56-40D4-B935-3DC18C3AA007}',
      '    DefaultVersion    REG_DWORD    0x2',
      REG_OUTPUT
    ].join('\r\n')
    expect(parseDefaultWslDistroId(output)).toBe('0283592d-be56-40d4-b935-3dc18c3aa007')
  })
})
