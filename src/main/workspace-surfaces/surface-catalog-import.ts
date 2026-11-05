import { randomUUID } from 'node:crypto'
import type Database from '../sqlite/sync-database'
import { normalizeOrcadMigrationImportReceipts } from '../../shared/orcad-migration/orcad-migration-manifest-validation'
import { normalizeOrcadMigrationStagedCatalogs } from '../../shared/orcad-migration/orcad-migration-staged-catalog-validation'
import { normalizeOrcadMigrationEvictedReceipts } from '../../shared/orcad-migration/orcad-migration-evicted-receipts'
import { assertOrcadMigrationReceiptMatchesManifest } from '../persistence/migrating-orcad-catalog/orcad-catalog-row-identity'
import { prepareOrcadMigrationWorkspaceSession } from '../persistence/migrating-orcad-catalog/orcad-destination-workspace-session'
import type { ProfileStateDomainMutation } from '../persistence/profile-state/profile-state-domain-writes'
import {
  captureSurfaceProfileDomain,
  markSurfaceIndices,
  readSurfaceProfileDomain,
  restoreSurfaceIndices,
  surfaceDomainFingerprint
} from './surface-profile-storage'
import { readSurfaceHostSession } from './surface-host-profile-session'
import { WorkspaceSurfaceRepository } from './surface-repository'
import { applySurfaceStorageCommand } from './surface-storage-apply'
import { projectSurfaceSession } from '../../shared/workspace-surfaces/surface-session-projection'
import { updateTerminalBaselines } from './surface-terminal-baselines'

/** The admitted staged manifest authorizes import; a session replacement alone never does. */
export function admitSurfaceCatalogImports(
  db: Database.Database,
  replacements: readonly ProfileStateDomainMutation[]
) {
  if (!replacements.some(({ domain }) => domain === 'orcadMigrationImportReceipts')) {
    return undefined
  }
  const read = (domain: string): unknown => {
    const payload = db
      .prepare('SELECT payload FROM main.profile_state_documents WHERE domain = ?')
      .get(domain)?.payload
    return typeof payload === 'string' ? JSON.parse(payload) : undefined
  }
  const overlay = (domain: string): unknown => {
    const mutation = replacements.find((entry) => entry.domain === domain)
    return mutation
      ? mutation.payload === null
        ? undefined
        : JSON.parse(mutation.payload)
      : read(domain)
  }
  const previous = new Map(
    [
      ...normalizeOrcadMigrationImportReceipts(read('orcadMigrationImportReceipts')),
      ...normalizeOrcadMigrationEvictedReceipts(read('orcadMigrationEvictedReceipts'))
    ].map((receipt) => [receipt.migrationId, receipt.manifestSha256])
  )
  const admitted = normalizeOrcadMigrationStagedCatalogs(read('orcadMigrationStagedCatalogs'))
  const remaining = normalizeOrcadMigrationStagedCatalogs(overlay('orcadMigrationStagedCatalogs'))
  const imports = normalizeOrcadMigrationImportReceipts(
    overlay('orcadMigrationImportReceipts')
  ).filter((receipt) => {
    const digest = previous.get(receipt.migrationId)
    if (digest !== undefined && digest !== receipt.manifestSha256) {
      throw new Error('orcad_migration_id_reused_with_different_manifest')
    }
    return digest === undefined
  })
  if (imports.length === 0) {
    return undefined
  }
  const carrier = readSurfaceProfileDomain(db)
  // Legacy/offline callers retain their existing path until canonical initialization.
  if (!carrier.hosts.local?.terminalInitialized) {
    return undefined
  }
  const fingerprint = surfaceDomainFingerprint(JSON.stringify(carrier))
  restoreSurfaceIndices(db, carrier, fingerprint)
  const repository = new WorkspaceSurfaceRepository({
    db,
    readOnly: false,
    transaction: (run) => run(db)
  })
  let session = projectSurfaceSession(
    'local',
    readSurfaceHostSession(db, 'local'),
    carrier.hosts.local.surfaces,
    carrier.hosts.local.chatInitialization === 'verified'
  )
  for (const receipt of imports) {
    const stage = admitted.find(({ manifest }) => manifest.migrationId === receipt.migrationId)
    if (
      !stage ||
      remaining.some(({ manifest }) => manifest.migrationId === receipt.migrationId) ||
      stage.manifest.manifestSha256 !== receipt.manifestSha256
    ) {
      throw new Error('orcad_migration_durable_stage_required')
    }
    assertOrcadMigrationReceiptMatchesManifest(receipt, stage.manifest)
    const seed = stage.manifest.payload.dormantState?.workspaceSession
    if (!seed) {
      continue
    }
    const merged = prepareOrcadMigrationWorkspaceSession(seed, {
      workspaceSession: session
    }).merged!
    applySurfaceStorageCommand(
      db,
      repository,
      carrier,
      'local',
      merged,
      { type: 'initialize', hostId: 'local' },
      randomUUID,
      Date.now
    )
    const current = captureSurfaceProfileDomain(db, carrier)
    Object.assign(carrier, current)
    updateTerminalBaselines(db, carrier, 'local', randomUUID)
    session = projectSurfaceSession(
      'local',
      merged,
      carrier.hosts.local!.surfaces,
      carrier.hosts.local!.chatInitialization === 'verified'
    )
  }
  updateTerminalBaselines(db, carrier, 'local', randomUUID)
  markSurfaceIndices(db, surfaceDomainFingerprint(JSON.stringify(carrier)))
  return carrier
}
