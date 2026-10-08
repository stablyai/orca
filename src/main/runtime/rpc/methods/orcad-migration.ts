import type { z } from 'zod'
import { OrcadMigrationCatalogParams } from '../../../../shared/rpc-contract/orcad-migration-params'
import { parseOrcadMigrationManifest } from '../../../../shared/orcad-migration-manifest'
import { OrcadMigrationSnapshotChunkRequestSchema } from '../../../../shared/orcad-migration-scrollback'
import { assertOrcadMigrationManifestDigest } from '../../../orcad/orcad-migration-manifest-digest'
import { defineMethod, type RpcContext } from '../core'

export const ORCAD_MIGRATION_METHODS = [
  defineMethod({
    name: 'orcad.migration.stageCatalog',
    params: OrcadMigrationCatalogParams,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.stageOrcadMigrationCatalog(migrationManifest(params), {
        signal: context.signal
      })
    }
  }),
  defineMethod({
    name: 'orcad.migration.commitCatalog',
    params: OrcadMigrationCatalogParams,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.commitStagedOrcadMigrationCatalog(migrationManifest(params), {
        signal: context.signal
      })
    }
  }),
  defineMethod({
    name: 'orcad.migration.stageSnapshotChunk',
    params: OrcadMigrationSnapshotChunkRequestSchema,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.stageOrcadMigrationSnapshotChunk(params)
    }
  }),
  defineMethod({
    name: 'orcad.migration.abortCatalog',
    params: OrcadMigrationCatalogParams,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.abortStagedOrcadMigrationCatalog(migrationManifest(params), {
        signal: context.signal
      })
    }
  }),
  defineMethod({
    name: 'orcad.migration.catalogState',
    params: OrcadMigrationCatalogParams,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.getOrcadMigrationCatalogState(migrationManifest(params))
    }
  })
]

function migrationManifest(params: z.infer<typeof OrcadMigrationCatalogParams>) {
  const manifest = parseOrcadMigrationManifest(params.manifest)
  // Raw, not parsed: parsing drops fields this host predates, which a newer client signed.
  assertOrcadMigrationManifestDigest(params.manifest)
  return manifest
}

function requireMigrationRuntimeClient(context: RpcContext): void {
  if (context.clientKind !== 'runtime' || !context.pairedDeviceId) {
    throw new Error('orcad_migration_runtime_client_required')
  }
}
