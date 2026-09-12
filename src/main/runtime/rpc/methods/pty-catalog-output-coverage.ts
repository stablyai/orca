import { z } from 'zod'
import { defineMethod } from '../core'
import { requirePairedRuntimeClient } from './pty-transfer-caller-authority'
import { PTY_CAPTURED_DESTINATION_OUTPUT_COVERAGE_METHOD } from '../../../../shared/pty-ownership-transfer-runtime-methods'
import {
  parseOrcadCatalogOutputCoverageRequest,
  parseOrcadCatalogOutputCoverageResult
} from '../../../ssh/orcad-catalog-output-coverage-contract'
import { assertOrcadMigrationManifestDigest } from '../../../orcad/orcad-migration-manifest-digest'
import { serializeOrcadMigrationValue } from '../../../../shared/orcad-migration-manifest'

export const INSPECT_CAPTURED_CATALOG_OUTPUT_COVERAGE_METHOD = defineMethod({
  name: PTY_CAPTURED_DESTINATION_OUTPUT_COVERAGE_METHOD,
  params: z.object({
    version: z.literal(1),
    identity: z.unknown(),
    publicationReceipt: z.unknown(),
    catalogAdmission: z.unknown(),
    throughSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
  }),
  handler: async (params, context) => {
    requirePairedRuntimeClient(context)
    if (!context.signal || !context.runtime.supportsCapturedCatalogOutputCoverage()) {
      throw new Error('orcad_catalog_output_coverage_unavailable')
    }
    context.signal.throwIfAborted()
    const expected = parseOrcadCatalogOutputCoverageRequest(params)
    const manifest = expected.catalogAdmission.manifest
    assertOrcadMigrationManifestDigest(manifest)
    const before = context.runtime.getOrcadMigrationCatalogState(manifest)
    if (before.state !== 'committed') {
      throw new Error('orcad_catalog_output_coverage_catalog_not_committed')
    }
    const result = await context.runtime.inspectCapturedPtyDestinationOutputCoverage(
      expected.identity,
      expected.throughSeq,
      context.signal
    )
    context.signal.throwIfAborted()
    if (
      !context.runtime.supportsCapturedCatalogOutputCoverage() ||
      serializeOrcadMigrationValue(before) !==
        serializeOrcadMigrationValue(context.runtime.getOrcadMigrationCatalogState(manifest)) ||
      serializeOrcadMigrationValue(result.catalogAdmission) !==
        serializeOrcadMigrationValue(expected.catalogAdmission)
    ) {
      throw new Error('orcad_catalog_output_coverage_catalog_changed')
    }
    return parseOrcadCatalogOutputCoverageResult(
      {
        version: 1,
        ...result,
        catalog: { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 }
      },
      expected
    )
  }
})
