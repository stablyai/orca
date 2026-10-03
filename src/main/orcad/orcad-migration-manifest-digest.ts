import { createHash } from 'node:crypto'
import {
  orcadMigrationManifestHashInput,
  type OrcadMigrationManifest
} from '../../shared/orcad-migration-manifest'

export function computeOrcadMigrationManifestSha256(
  manifest: Omit<OrcadMigrationManifest, 'manifestSha256'>
): string {
  return createHash('sha256').update(orcadMigrationManifestHashInput(manifest)).digest('hex')
}

export function assertOrcadMigrationManifestDigest(manifest: OrcadMigrationManifest): void {
  const { manifestSha256, ...unsigned } = manifest
  if (computeOrcadMigrationManifestSha256(unsigned) !== manifestSha256) {
    throw new Error('orcad_migration_manifest_digest_mismatch')
  }
}
