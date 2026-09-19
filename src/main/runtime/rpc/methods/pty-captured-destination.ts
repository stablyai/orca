import { z } from 'zod'
import { defineMethod } from '../core'
import { requirePairedRuntimeClient } from './pty-transfer-caller-authority'
import {
  PTY_CAPTURED_DESTINATION_PREPARE_METHOD,
  PTY_CAPTURED_DESTINATION_CAPABILITIES_METHOD
} from '../../../../shared/pty-ownership-transfer-runtime-methods'
import { parsePtyOwnershipTransferWireIdentity } from '../../../../shared/pty-ownership-transfer-wire'
import { parsePtyOwnershipTransferDelegatedSource } from '../../../persistence/pty-ownership-transfer/pty-ownership-transfer-delegated-source'
import { parsePtyOwnershipInitialModelSnapshot } from '../../../persistence/pty-ownership-transfer/pty-ownership-transfer-initial-model-snapshot'
import { parseOrcadTerminalLayoutAdmission } from '../../../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission'
import { samePtyOwnershipTransferIdentity } from '../../../../shared/pty-ownership-transfer-identity'

const captureParams = z.object({
  identity: z.unknown(),
  source: z.unknown(),
  model: z.object({ throughSeq: z.number().int().nonnegative().safe() }).passthrough(),
  selection: z.unknown().optional(),
  timeoutMs: z.number().int().positive().max(60_000).optional()
})

export const CAPTURED_PTY_DESTINATION_CAPABILITIES_METHOD = defineMethod({
  name: PTY_CAPTURED_DESTINATION_CAPABILITIES_METHOD,
  params: z.object({ version: z.literal(1) }),
  handler: (_params, context) => {
    requirePairedRuntimeClient(context)
    if (!context.signal) {
      throw new Error('pty_ownership_transfer_captured_connection_signal_required')
    }
    context.signal.throwIfAborted()
    return {
      version: 1 as const,
      // Session snapshots bind incarnation to the live PTY used to issue each handle.
      sessionTerminalIdentity: 1 as const,
      ...([
        context.runtime.stageOrcadMigrationCatalog,
        context.runtime.commitStagedOrcadMigrationCatalog,
        context.runtime.stageOrcadMigrationSnapshotChunk,
        context.runtime.abortStagedOrcadMigrationCatalog,
        context.runtime.getOrcadMigrationCatalogState
      ].every((method) => typeof method === 'function')
        ? { catalogMigrationVersion: 1 as const }
        : {}),
      catalogPublication: context.runtime.supportsCapturedCatalogPublication()
        ? (1 as const)
        : null,
      ...(context.runtime.supportsCapturedCatalogActivation?.()
        ? { catalogActivation: 1 as const }
        : {}),
      ...(context.runtime.supportsCapturedCatalogOutputCoverage?.()
        ? { catalogOutputCoverage: 1 as const }
        : {}),
      ...(context.runtime.supportsCapturedSourceRetirement?.()
        ? { sourceRetirement: 1 as const }
        : {}),
      ...(context.runtime.supportsCapturedSourceRetirementRecovery?.()
        ? { sourceRetirementRecovery: 1 as const }
        : {})
    }
  }
})

export const PREPARE_CAPTURED_PTY_DESTINATION_METHOD = defineMethod({
  name: PTY_CAPTURED_DESTINATION_PREPARE_METHOD,
  params: z.discriminatedUnion('version', [
    captureParams.extend({ version: z.literal(1), catalogAdmission: z.never().optional() }),
    captureParams.extend({
      version: z.literal(2),
      catalogAdmission: z.object({ version: z.literal(1) }).passthrough()
    })
  ]),
  handler: async (params, context) => {
    requirePairedRuntimeClient(context)
    if (!context.signal) {
      throw new Error('pty_ownership_transfer_captured_connection_signal_required')
    }
    context.signal.throwIfAborted()
    const identity = parsePtyOwnershipTransferWireIdentity(params.identity)
    const catalog =
      params.version === 2 ? parseOrcadTerminalLayoutAdmission(params.catalogAdmission) : undefined
    if (
      catalog &&
      (!context.runtime.supportsCapturedCatalogPublication() ||
        !catalog.bindings.some((entry) =>
          samePtyOwnershipTransferIdentity(entry.identity, identity)
        ))
    ) {
      throw new Error('pty_ownership_transfer_captured_catalog_unavailable')
    }
    const source = parsePtyOwnershipTransferDelegatedSource(params.source, identity)
    const model = parsePtyOwnershipInitialModelSnapshot(
      params.model,
      identity,
      params.model.throughSeq
    )
    const result = await context.runtime.prepareCapturedPtyDestination({
      identity,
      source,
      model,
      ...(catalog ? { catalogAdmission: catalog } : {}),
      ...(params.selection === undefined ? {} : { selection: params.selection }),
      signal: context.signal,
      ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs })
    })
    return {
      version: params.version,
      ...(catalog
        ? {
            catalog: {
              migrationId: catalog.manifest.migrationId,
              manifestSha256: catalog.manifest.manifestSha256
            }
          }
        : {}),
      outcome: 'published' as const,
      identity: result.snapshot.identity,
      importReceipt: result.importReceipt,
      publicationReceipt: result.publicationReceipt
    }
  }
})
