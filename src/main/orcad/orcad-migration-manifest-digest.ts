import { createHash } from 'node:crypto'
import {
  orcadMigrationManifestHashInput,
  serializeOrcadMigrationValue,
  type OrcadMigrationManifest
} from '../../shared/orcad-migration-manifest'

export function computeOrcadMigrationManifestSha256(
  manifest: Omit<OrcadMigrationManifest, 'manifestSha256'>
): string {
  return createHash('sha256').update(orcadMigrationManifestHashInput(manifest)).digest('hex')
}

/** Pass the manifest as received: a newer peer's unknown fields are part of what it signed. */
export function assertOrcadMigrationManifestDigest(manifest: unknown): void {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error('orcad_migration_manifest_invalid')
  }
  const unsigned = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== 'manifestSha256')
  )
  const digest = createHash('sha256').update(serializeOrcadMigrationValue(unsigned)).digest('hex')
  if (!('manifestSha256' in manifest) || digest !== manifest.manifestSha256) {
    throw new Error('orcad_migration_manifest_digest_mismatch')
  }
}
