import { z } from 'zod'
import { defineMethod } from '../core'
import { requirePairedRuntimeClient } from './pty-transfer-caller-authority'
import { PTY_CAPTURED_DESTINATION_ACTIVATION_METHOD } from '../../../../shared/pty-ownership-transfer-runtime-methods'
import {
  parseOrcadCatalogActivationRequest,
  parseOrcadCatalogActivationResult
} from '../../../ssh/orcad-catalog-activation-contract'
import { assertOrcadMigrationManifestDigest } from '../../../orcad/orcad-migration-manifest-digest'
import { serializeOrcadMigrationValue } from '../../../../shared/orcad-migration-manifest'

export const INSPECT_CAPTURED_CATALOG_ACTIVATION_METHOD = defineMethod({
  name: PTY_CAPTURED_DESTINATION_ACTIVATION_METHOD,
  params: z.object({
    version: z.literal(1),
    identity: z.unknown(),
    publicationReceipt: z.unknown(),
    catalogAdmission: z.unknown()
  }),
  handler: async (params, context) => {
    requirePairedRuntimeClient(context)
    if (!context.signal || !context.runtime.supportsCapturedCatalogActivation()) {
      throw new Error('orcad_catalog_activation_unavailable')
    }
    context.signal.throwIfAborted()
    const expected = parseOrcadCatalogActivationRequest(params)
    const manifest = expected.catalogAdmission.manifest
    assertOrcadMigrationManifestDigest(manifest)
    const before = context.runtime.getOrcadMigrationCatalogState(manifest)
    if (before.state !== 'committed') {
      throw new Error('orcad_catalog_activation_catalog_not_committed')
    }
    const activation = await context.runtime.inspectCapturedPtyDestinationActivation(
      expected.identity,
      context.signal
    )
    context.signal.throwIfAborted()
    const after = context.runtime.getOrcadMigrationCatalogState(manifest)
    if (
      serializeOrcadMigrationValue(before) !== serializeOrcadMigrationValue(after) ||
      serializeOrcadMigrationValue(activation.catalogAdmission) !==
        serializeOrcadMigrationValue(expected.catalogAdmission)
    ) {
      throw new Error('orcad_catalog_activation_catalog_changed')
    }
    return parseOrcadCatalogActivationResult(
      {
        version: 1,
        ...activation,
        catalog: { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 }
      },
      expected
    )
  }
})
