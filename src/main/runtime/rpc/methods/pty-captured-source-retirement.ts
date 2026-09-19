import { z } from 'zod'
import { parsePtyOwnershipTransferSourceRetirementEvidence } from '../../../../shared/pty-ownership-transfer-source-retirement'
import { defineMethod } from '../core'
import { requirePairedRuntimeClient } from './pty-transfer-caller-authority'
import { PTY_CAPTURED_SOURCE_RETIREMENT_METHOD } from '../../../../shared/pty-ownership-transfer-runtime-methods'
import { parsePtyOwnershipCaptureBoundary } from '../../../../shared/pty-ownership-capture-boundary'
import { serializeOrcadMigrationValue } from '../../../../shared/orcad-migration-manifest'
import { assertOrcadMigrationManifestDigest } from '../../../orcad/orcad-migration-manifest-digest'
import {
  parseOrcadCatalogActivationRequest,
  parseOrcadCatalogActivationResult
} from '../../../ssh/orcad-catalog-activation-contract'

export const RETIRE_CAPTURED_SOURCE_DELIVERY_METHOD = defineMethod({
  name: PTY_CAPTURED_SOURCE_RETIREMENT_METHOD,
  params: z.object({
    version: z.literal(1),
    identity: z.unknown(),
    publicationReceipt: z.unknown(),
    catalogAdmission: z.unknown(),
    retirementRecordSha256: z.string().regex(/^[a-f0-9]{64}$/),
    expectedDelivery: z.unknown(),
    recoveryOnly: z.boolean().optional()
  }),
  handler: async (params, context) => {
    requirePairedRuntimeClient(context)
    const signal = context.signal
    if (
      !signal ||
      !context.runtime.supportsCapturedSourceRetirement() ||
      (params.recoveryOnly && context.runtime.supportsCapturedSourceRetirementRecovery?.() !== true)
    ) {
      throw new Error('orcad_captured_source_retirement_unavailable')
    }
    signal.throwIfAborted()
    const expected = parseOrcadCatalogActivationRequest(params)
    const manifest = expected.catalogAdmission.manifest
    assertOrcadMigrationManifestDigest(manifest)
    const delivery = parsePtyOwnershipCaptureBoundary(
      { version: 1, identity: expected.identity, throughSeq: 0, delivery: params.expectedDelivery },
      expected.identity
    ).delivery
    const before = context.runtime.getOrcadMigrationCatalogState(manifest)
    if (before.state !== 'committed') {
      throw new Error('orcad_catalog_activation_catalog_not_committed')
    }
    const beforeValue = serializeOrcadMigrationValue(before)
    let active = true
    const assertAuthority = () => {
      signal.throwIfAborted()
      if (
        !active ||
        !context.runtime.supportsCapturedSourceRetirement() ||
        (params.recoveryOnly &&
          context.runtime.supportsCapturedSourceRetirementRecovery?.() !== true) ||
        serializeOrcadMigrationValue(context.runtime.getOrcadMigrationCatalogState(manifest)) !==
          beforeValue
      ) {
        throw new Error('orcad_captured_source_retirement_authority_changed')
      }
    }
    try {
      assertAuthority()
      const result = await context.runtime.retireCapturedSourceDelivery({
        identity: expected.identity,
        retirementRecordSha256: params.retirementRecordSha256,
        expectedDelivery: delivery,
        ...(params.recoveryOnly === undefined ? {} : { recoveryOnly: params.recoveryOnly }),
        signal,
        assertAuthority,
        assertActivation: (activation) => {
          assertAuthority()
          if (
            serializeOrcadMigrationValue(activation.catalogAdmission) !==
            serializeOrcadMigrationValue(expected.catalogAdmission)
          ) {
            throw new Error('orcad_catalog_activation_catalog_changed')
          }
          parseOrcadCatalogActivationResult(
            {
              version: 1,
              ...activation,
              catalog: {
                migrationId: manifest.migrationId,
                manifestSha256: manifest.manifestSha256
              }
            },
            expected
          )
        }
      })
      assertAuthority()
      if (params.recoveryOnly) {
        const evidence = parsePtyOwnershipTransferSourceRetirementEvidence(result)
        if (!evidence.sourceCancellation) {
          throw new Error('pty_source_retirement_cancellation_required')
        }
        return evidence
      }
      return result
    } finally {
      active = false
    }
  }
})
