import { describe, expect, it } from 'vitest'
import type { OrcadMigrationManifestSource } from '../../shared/orcad-migration-manifest'
import {
  assertOrcadMigrationSourceServedHere,
  ORCAD_MIGRATION_SOURCE_NOT_THIS_HOST,
  servesLocalWslMigrationSource
} from './orcad-migration-wsl-destination'

const WSL_SOURCE: OrcadMigrationManifestSource = {
  kind: 'local-wsl',
  distro: 'Ubuntu',
  scopeRepoIds: ['repo-1'],
  scopeFolderWorkspaceIds: [],
  generation: 1
}
const SSH_SOURCE: OrcadMigrationManifestSource = {
  sshTargetId: 'ssh-1',
  sshTargetGeneration: 1,
  targetLabel: 'Prod'
}
const WSL_HOST = { ORCA_WSL_ORCAD_HOST: '1', WSL_DISTRO_NAME: 'ubuntu' }

describe('WSL migration destination', () => {
  it('serves the WSL source only on the orcad Orca launched inside a distro', () => {
    expect(servesLocalWslMigrationSource(WSL_HOST, 'linux')).toBe(true)
    // An SSH remote or Orca under WSLg is a WSL guest too, but not a WSL host's orcad.
    expect(servesLocalWslMigrationSource({ WSL_DISTRO_NAME: 'Ubuntu' }, 'linux')).toBe(false)
    expect(servesLocalWslMigrationSource(WSL_HOST, 'win32')).toBe(false)
  })

  it('accepts its own distro, case-insensitively', () => {
    expect(() => assertOrcadMigrationSourceServedHere(WSL_SOURCE, WSL_HOST, 'linux')).not.toThrow()
  })

  it.each([
    ['another distro', { ...WSL_HOST, WSL_DISTRO_NAME: 'Debian' }, 'linux'],
    ['a plain Linux host', {}, 'linux'],
    ['a desktop', WSL_HOST, 'darwin']
  ] as const)('refuses a WSL source on %s', (_label, env, platform) => {
    expect(() => assertOrcadMigrationSourceServedHere(WSL_SOURCE, env, platform)).toThrow(
      ORCAD_MIGRATION_SOURCE_NOT_THIS_HOST
    )
  })

  it('refuses a source from another registration of the same distro name', () => {
    const source = { ...WSL_SOURCE, distroGuid: '{AAAA}' }
    expect(() =>
      assertOrcadMigrationSourceServedHere(
        source,
        { ...WSL_HOST, ORCA_WSL_DISTRO_GUID: '{aaaa}' },
        'linux'
      )
    ).not.toThrow()
    for (const env of [{ ...WSL_HOST, ORCA_WSL_DISTRO_GUID: '{BBBB}' }, WSL_HOST]) {
      expect(() => assertOrcadMigrationSourceServedHere(source, env, 'linux')).toThrow(
        ORCAD_MIGRATION_SOURCE_NOT_THIS_HOST
      )
    }
  })

  it('leaves the SSH conversion alone everywhere', () => {
    expect(() => assertOrcadMigrationSourceServedHere(SSH_SOURCE, {}, 'linux')).not.toThrow()
  })
})
