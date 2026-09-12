import { join } from 'node:path'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { parseOrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { assertOrcadMigrationManifestDigest } from '../orcad/orcad-migration-manifest-digest'
import { groupOrcadLiveCatalogAdmissions } from './orcad-live-catalog-admissions'
import {
  parseOrcadCatalogActivationRequest,
  parseOrcadCatalogActivationResult
} from './orcad-catalog-activation-contract'
import { OrcadOutgoingEvidenceStore } from './orcad-outgoing-evidence-store'

export function parseOrcadLiveSourceReleaseIntent(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('orcad_live_source_release_intent_invalid')
  }
  const record = value as Record<string, unknown>
  const cutover = parseOrcadMigrationSourceCutover(record.cutover)
  if (
    record.version !== 1 ||
    cutover.version !== 2 ||
    cutover.phase !== 'destination-committed' ||
    !Array.isArray(record.activations) ||
    record.activations.length !== cutover.liveTerminalBindings!.length
  ) {
    throw new Error('orcad_live_source_release_intent_incomplete')
  }
  assertOrcadMigrationManifestDigest(cutover.manifest)
  const supplied = record.activations
  const activations = groupOrcadLiveCatalogAdmissions(cutover).flatMap((catalogAdmission) =>
    catalogAdmission.bindings.map(({ identity }) => {
      const publication = cutover.terminalPublications!.find(
        (entry) => entry.identity.bridgeId === identity.bridgeId
      )!
      const matches = supplied.filter(
        (value) =>
          value &&
          typeof value === 'object' &&
          samePtyOwnershipTransferIdentity(
            parsePtyOwnershipTransferWireIdentity(value.identity),
            identity
          )
      )
      if (matches.length !== 1) {
        throw new Error('orcad_live_source_release_intent_incomplete')
      }
      return parseOrcadCatalogActivationResult(
        matches[0],
        parseOrcadCatalogActivationRequest({
          identity,
          catalogAdmission,
          publicationReceipt: publication.publicationReceipt
        })
      )
    })
  )
  const identity = cutover.liveTerminalBindings![0].identity
  if (
    record.identity !== undefined &&
    !samePtyOwnershipTransferIdentity(
      parsePtyOwnershipTransferWireIdentity(record.identity),
      identity
    )
  ) {
    throw new Error('orcad_live_source_release_intent_identity_mismatch')
  }
  return { version: 1 as const, identity, cutover, activations }
}

export function assertOrcadLiveSourceReleaseCompatible(
  candidate: ReturnType<typeof parseOrcadLiveSourceReleaseIntent>,
  existing: ReturnType<typeof parseOrcadLiveSourceReleaseIntent>
) {
  if (
    serializeOrcadMigrationValue(existing.cutover) !==
    serializeOrcadMigrationValue(candidate.cutover)
  ) {
    throw new Error('orcad_live_source_release_intent_conflict')
  }
  for (const observed of candidate.activations) {
    const original = existing.activations.find(
      (entry) => entry.identity.bridgeId === observed.identity.bridgeId
    )!
    if (
      observed.destinationClaim.generation < original.destinationClaim.generation ||
      (observed.destinationClaim.generation === original.destinationClaim.generation &&
        observed.destinationClaim.claimId !== original.destinationClaim.claimId)
    ) {
      throw new Error('orcad_live_source_release_activation_regressed')
    }
  }
}

/** Historical admission only; every release attempt still needs fresh authenticated activation. */
export class OrcadLiveSourceReleaseIntentStore extends OrcadOutgoingEvidenceStore<
  ReturnType<typeof parseOrcadLiveSourceReleaseIntent>
> {
  constructor(profileDirectory: string) {
    super(
      join(profileDirectory, 'orcad-live-source-release-intents'),
      parseOrcadLiveSourceReleaseIntent,
      'orcad_live_source_release_intent'
    )
  }
}
