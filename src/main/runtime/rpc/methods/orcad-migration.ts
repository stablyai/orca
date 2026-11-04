import type { z } from 'zod'
import {
  OrcadMigrationCatalogParams,
  OrcadMigrationCatalogReferenceParams,
  OrcadMigrationCommitCatalogParams
} from '../../../../shared/rpc-contract/orcad-migration-params'
import { parseOrcadMigrationManifest } from '../../../../shared/orcad-migration/orcad-migration-manifest-validation'
import { OrcadMigrationSnapshotChunkRequestSchema } from '../../../../shared/orcad-migration/orcad-migration-scrollback'
import { OrcadMigrationBlobChunkRequestSchema } from '../../../../shared/orcad-migration/orcad-migration-blob-transfer'
import { assertOrcadMigrationManifestDigest } from '../../../orcad/orcad-migration-manifest-digest'
import { assertOrcadMigrationSourceServedHere } from '../../../orcad/orcad-migration-wsl-destination'
import { defineMethod, type RpcContext } from '../core'

export const ORCAD_MIGRATION_METHODS = [
  defineMethod({
    name: 'orcad.migration.stageCatalog',
    permission: 'host-admin',
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
    permission: 'host-admin',
    params: OrcadMigrationCommitCatalogParams,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.commitStagedOrcadMigrationCatalog(migrationManifest(params), {
        signal: context.signal,
        ...(params.expectedBlobs ? { expectedBlobs: params.expectedBlobs } : {})
      })
    }
  }),
  defineMethod({
    name: 'orcad.migration.stageSnapshotChunk',
    permission: 'host-admin',
    params: OrcadMigrationSnapshotChunkRequestSchema,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.stageOrcadMigrationSnapshotChunk(params)
    }
  }),
  // A separate method, not a field on stageSnapshotChunk: an older host would strip the field and
  // stage the bytes as a snapshot.
  defineMethod({
    name: 'orcad.migration.stageBlobChunk',
    permission: 'host-admin',
    params: OrcadMigrationBlobChunkRequestSchema,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.stageOrcadMigrationBlobChunk(params)
    }
  }),
  defineMethod({
    name: 'orcad.migration.abortCatalog',
    permission: 'host-admin',
    params: OrcadMigrationCatalogParams,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.abortStagedOrcadMigrationCatalog(migrationManifest(params), {
        signal: context.signal
      })
    }
  }),
  // Why a reference: a source fenced on a manifest no request can carry must still be releasable.
  defineMethod({
    name: 'orcad.migration.abortCatalogByReference',
    permission: 'host-admin',
    params: OrcadMigrationCatalogReferenceParams,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.abortStagedOrcadMigrationCatalogByReference(params, {
        signal: context.signal
      })
    }
  }),
  defineMethod({
    name: 'orcad.migration.catalogState',
    permission: 'host-admin',
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
  assertOrcadMigrationSourceServedHere(manifest.source)
  return manifest
}

function requireMigrationRuntimeClient(context: RpcContext): void {
  if (context.clientKind !== 'runtime' || !context.pairedDeviceId) {
    throw new Error('orcad_migration_runtime_client_required')
  }
}
