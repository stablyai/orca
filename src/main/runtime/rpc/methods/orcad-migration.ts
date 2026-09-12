import { z } from 'zod'
import { parseOrcadMigrationManifest } from '../../../../shared/orcad-migration-manifest'
import { OrcadMigrationSnapshotChunkRequestSchema } from '../../../../shared/orcad-migration-scrollback'
import { assertOrcadMigrationManifestDigest } from '../../../orcad/orcad-migration-manifest-digest'
import { defineMethod, type RpcContext } from '../core'

const OrcadMigrationImport = z.object({ manifest: z.unknown() })

export const ORCAD_MIGRATION_METHODS = [
  defineMethod({
    name: 'orcad.migration.importCatalog',
    params: OrcadMigrationImport,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.importOrcadMigrationCatalog(migrationManifest(params), {
        signal: context.signal
      })
    }
  }),
  defineMethod({
    name: 'orcad.migration.stageCatalog',
    params: OrcadMigrationImport,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.stageOrcadMigrationCatalog(migrationManifest(params), {
        signal: context.signal
      })
    }
  }),
  defineMethod({
    name: 'orcad.migration.commitCatalog',
    params: OrcadMigrationImport,
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
    params: OrcadMigrationImport,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.abortStagedOrcadMigrationCatalog(migrationManifest(params), {
        signal: context.signal
      })
    }
  }),
  defineMethod({
    name: 'orcad.migration.catalogState',
    params: OrcadMigrationImport,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.getOrcadMigrationCatalogState(migrationManifest(params))
    }
  })
]

function migrationManifest(params: z.infer<typeof OrcadMigrationImport>) {
  const manifest = parseOrcadMigrationManifest(params.manifest)
  assertOrcadMigrationManifestDigest(manifest)
  return manifest
}

function requireMigrationRuntimeClient(context: RpcContext): void {
  if (context.clientKind !== 'runtime' || !context.pairedDeviceId) {
    throw new Error('orcad_migration_runtime_client_required')
  }
}
