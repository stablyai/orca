import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { withOrcadLiveRuntimeRestartReadiness } from './orcad-live-runtime-restart-readiness'
import { groupOrcadLiveCatalogAdmissions } from './orcad-live-catalog-admissions'
import { bindOrcadLiveRetirementCapture } from './orcad-live-retirement-capture'
import { bindReleasedOutgoingOrcadIncumbent } from './orcad-outgoing-source-binding'
import {
  createOrcadLiveSourceRetirementDelivery,
  reconstructOrcadLiveSourceRetirementDelivery
} from './orcad-live-source-retirement-delivery'
import { retireRemoteOrcadCapturedSourceDelivery } from './orcad-captured-source-retirement-client'
import { confirmSettledSourceDeliveryCancellation } from '../providers/ssh-pty-source-delivery-state'
import {
  createOrcadLiveSourceCancellationReceipt,
  OrcadLiveSourceCancellationReceiptStore
} from './orcad-live-source-cancellation-receipt'

/** Delivery retirement only; catalog/route retirement and whole-host completion remain separate. */
export async function retireOrcadLiveSourceDeliveries(
  options: Parameters<typeof withOrcadLiveRuntimeRestartReadiness>[0] & { recoveryOnly?: boolean }
) {
  return withOrcadLiveRuntimeRestartReadiness(options, async (context) => {
    const { record, outputEvidence, assertCurrent } = context
    const cutover = record.release.cutover
    const targetId = cutover.manifest.source.sshTargetId
    const receipts = new OrcadLiveSourceCancellationReceiptStore(options.profileDirectory)
    const bindReceipt = (receipt: ReturnType<typeof createOrcadLiveSourceCancellationReceipt>) => {
      const expected = createOrcadLiveSourceCancellationReceipt({
        record,
        settlements: outputEvidence.settlements,
        retirement: receipt.retirement,
        cancellation: receipt.cancellation
      })
      const canonical = serializeOrcadMigrationValue(expected)
      if (serializeOrcadMigrationValue(receipt) !== canonical) {
        throw new Error('orcad_live_retirement_receipt_conflict')
      }
      return () => {
        assertCurrent()
        if (serializeOrcadMigrationValue(receipts.read(receipt.identity)) !== canonical) {
          throw new Error('orcad_live_retirement_receipt_changed')
        }
      }
    }
    // Validate the entire cohort before the first host mutation.
    const prepared = groupOrcadLiveCatalogAdmissions(cutover).flatMap((catalogAdmission) =>
      catalogAdmission.bindings.map(({ identity }) => {
        const receipt = receipts.read(identity)
        if (receipt) {
          return { receipt, assertAuthority: bindReceipt(receipt) }
        }
        const capture = bindOrcadLiveRetirementCapture({
          ...options,
          identity,
          catalogAdmission,
          destinationEnvironmentId: cutover.destinationEnvironmentId,
          assertAuthority: assertCurrent
        })
        const source = options.recoveryOnly
          ? undefined
          : bindReleasedOutgoingOrcadIncumbent({
              identity,
              ptyId: toAppSshPtyId(targetId, identity.terminalId),
              sourceSshTargetId: targetId,
              signal: options.signal,
              assertAuthority: capture.assertCurrent
            })
        const historical = {
          identity,
          captureBoundary: capture.capture.selection.boundary,
          settlement: outputEvidence.settlements.find((entry) => entry.id === identity.terminalId)
        }
        const delivery = source
          ? createOrcadLiveSourceRetirementDelivery({
              ...historical,
              providerGeneration: source.providerGeneration
            })
          : reconstructOrcadLiveSourceRetirementDelivery(historical)
        const publication = cutover.terminalPublications!.find(
          (entry) => entry.identity.bridgeId === identity.bridgeId
        )
        if (!publication) {
          throw new Error('orcad_live_retirement_publication_required')
        }
        return {
          identity,
          catalogAdmission,
          source,
          delivery,
          publication,
          receipt: undefined,
          assertAuthority: source?.assertIncumbent ?? capture.assertCurrent
        }
      })
    )
    const assertCohort = () => {
      assertCurrent()
      for (const entry of prepared) {
        entry.assertAuthority()
      }
    }
    assertCohort()
    const confirmed: ReturnType<typeof createOrcadLiveSourceCancellationReceipt>[] = []
    for (const entry of prepared) {
      assertCohort()
      if (entry.receipt) {
        confirmed.push(receipts.persist(entry.receipt))
        assertCohort()
        continue
      }
      const retirement = await retireRemoteOrcadCapturedSourceDelivery({
        pairingCode: context.pairingCode,
        signal: options.signal,
        assertAuthority: assertCohort,
        request: {
          identity: entry.identity,
          catalogAdmission: entry.catalogAdmission,
          publicationReceipt: entry.publication.publicationReceipt,
          retirementRecordSha256: record.sha256,
          expectedDelivery: entry.delivery,
          ...(options.recoveryOnly ? { recoveryOnly: true } : {})
        }
      })
      assertCohort()
      const cancellation = entry.source
        ? (
            await confirmSettledSourceDeliveryCancellation(
              { request: entry.source.request },
              entry.identity,
              retirement.sourceDeliveryRetirement.delivery,
              assertCohort,
              { signal: options.signal }
            )
          ).cancellation
        : retirement.sourceCancellation
      if (!cancellation) {
        throw new Error('orcad_live_retirement_cancellation_required')
      }
      assertCohort()
      const receipt = createOrcadLiveSourceCancellationReceipt({
        record,
        settlements: outputEvidence.settlements,
        retirement,
        cancellation
      })
      const saved = receipts.persist(receipt)
      entry.assertAuthority = bindReceipt(saved)
      confirmed.push(saved)
      assertCohort()
    }
    return { phase: 'source-deliveries-retired' as const, receipts: confirmed }
  })
}
