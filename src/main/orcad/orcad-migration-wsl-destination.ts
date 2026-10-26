// In-place WSL moves require the desktop-launched orcad in the source distro to own the unchanged paths.
import type { OrcadMigrationManifestSource } from '../../shared/orcad-migration/orcad-migration-manifest'
import { isOrcadMigrationLocalWslSource } from '../../shared/orcad-migration/orcad-migration-source-kind'
import { isWslHostOrcadProcess } from '../ipc/wsl-guest-windows-drive-path'

export const ORCAD_MIGRATION_SOURCE_NOT_THIS_HOST = 'orcad_migration_source_not_this_host'

/** Desktop-provided registry ID; guests cannot read it themselves. */
export const ORCAD_WSL_DISTRO_GUID_ENV = 'ORCA_WSL_DISTRO_GUID'

export function servesLocalWslMigrationSource(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  return isWslHostOrcadProcess(env, platform)
}

export function assertOrcadMigrationSourceServedHere(
  source: OrcadMigrationManifestSource,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): void {
  if (!isOrcadMigrationLocalWslSource(source)) {
    return
  }
  // WSL distro names and their UNC forms are case-insensitive.
  const distro = env.WSL_DISTRO_NAME?.trim().toLowerCase()
  if (!servesLocalWslMigrationSource(env, platform) || distro !== source.distro.toLowerCase()) {
    throw new Error(ORCAD_MIGRATION_SOURCE_NOT_THIS_HOST)
  }
  // Re-registering a distro reuses its name, not its files; require its registry ID when supplied.
  const guid = env[ORCAD_WSL_DISTRO_GUID_ENV]?.trim().toLowerCase()
  if (source.distroGuid !== undefined && guid !== source.distroGuid.toLowerCase()) {
    throw new Error(ORCAD_MIGRATION_SOURCE_NOT_THIS_HOST)
  }
}
