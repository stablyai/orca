import { parseOrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import { commitOrcadLiveDestination } from './orcad-live-destination-commit'
import { assertOrcadLiveCutoverCurrent } from './orcad-live-cutover-current'
import { groupOrcadLiveCatalogAdmissions } from './orcad-live-catalog-admissions'
import { inspectRemoteOrcadCatalogActivation } from './orcad-catalog-activation-client'
import { withOrcadLiveSourceRecovery } from './orcad-live-source-recovery'
import {
  parseOrcadCatalogActivationRequest,
  parseOrcadCatalogActivationResult
} from './orcad-catalog-activation-contract'

/** Caller retains source lifecycle locks; a returned cohort does not itself retire source authority. */
export async function inspectOrcadLiveDestinationActivations(
  options: Parameters<typeof commitOrcadLiveDestination>[0] & {
    activate?: typeof inspectRemoteOrcadCatalogActivation
  }
) {
  const initial = parseOrcadMigrationSourceCutover(options.cutover)
  if (initial.version !== 2 || initial.phase !== 'destination-committed') {
    throw new Error('orcad_live_cutover_activation_requires_commit')
  }
  groupOrcadLiveCatalogAdmissions(initial)
  // Reflush destination commit before treating its status as durable migration progress.
  const cutover = await commitOrcadLiveDestination({ ...options, cutover: initial })
  const assertCurrent = () => assertOrcadLiveCutoverCurrent({ ...options, cutover })
  return inspectOrcadLiveCatalogActivationCohort({ ...options, cutover, assertCurrent })
}

/** Caller supplies a durable commit and authority that remains valid for its profile phase. */
export async function inspectOrcadLiveCatalogActivationCohort(options: {
  cutover: unknown
  pairingCode: string
  signal: AbortSignal
  assertCurrent: () => void
  activate?: typeof inspectRemoteOrcadCatalogActivation
}) {
  const cutover = parseOrcadMigrationSourceCutover(options.cutover)
  if (cutover.version !== 2 || cutover.phase !== 'destination-committed') {
    throw new Error('orcad_live_cutover_activation_requires_commit')
  }
  const admissions = groupOrcadLiveCatalogAdmissions(cutover)
  const assertCurrent = () => {
    options.signal.throwIfAborted()
    options.assertCurrent()
  }
  const activate = options.activate ?? inspectRemoteOrcadCatalogActivation
  const activations: ReturnType<typeof parseOrcadCatalogActivationResult>[] = []
  for (const catalogAdmission of admissions) {
    for (const { identity } of catalogAdmission.bindings) {
      assertCurrent()
      const publication = cutover.terminalPublications!.find(
        (entry) => entry.identity.bridgeId === identity.bridgeId
      )!
      const request = parseOrcadCatalogActivationRequest({
        identity,
        catalogAdmission,
        publicationReceipt: publication.publicationReceipt
      })
      const result = await activate({
        pairingCode: options.pairingCode,
        request,
        signal: options.signal
      })
      assertCurrent()
      activations.push(parseOrcadCatalogActivationResult(result, request))
    }
  }
  assertCurrent()
  return { cutover, activations }
}

export async function inspectOrcadLiveSourceReleaseReadiness(
  options: Parameters<typeof withOrcadLiveSourceRecovery>[0] & {
    remote?: Parameters<typeof commitOrcadLiveDestination>[0]['remote']
    activate?: typeof inspectRemoteOrcadCatalogActivation
  }
) {
  return withOrcadLiveSourceRecovery(options, (context) =>
    inspectOrcadLiveDestinationActivations({ ...options, ...context })
  )
}
