import type { Store } from '../persistence'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { parsePtyOwnershipTransferSuccessorRetirementRequest } from '../../shared/pty-ownership-transfer-successor-retirement'
import { withOrcadCommittedSuccessorProfileAuthority } from './orcad-committed-profile-authority'
import { inspectOrcadLiveCutoverRecovery } from './orcad-live-cutover-recovery-inspection'
import { OrcadLiveSourceRetirementRecordStore } from './orcad-live-source-retirement-record'
import { groupOrcadLiveCatalogAdmissions } from './orcad-live-catalog-admissions'
import { bindOrcadLiveRetirementCapture } from './orcad-live-retirement-capture'
import { listValidatedOrcadLiveCancellationRecoveryReceipts } from './orcad-live-cancellation-recovery-receipts'
import { OrcadLiveSourceCancellationReceiptStore } from './orcad-live-source-cancellation-receipt'
import {
  createOrcadLiveCoveredCancellationReceipt,
  OrcadLiveCoveredCancellationReceiptStore
} from './orcad-live-covered-cancellation-receipt'
import { retireOrcadSuccessorSourceDelivery } from './orcad-successor-retirement-client'
import { retainOrcadLiveSuccessorSession } from './orcad-live-successor-session'
import { bindOrcadLiveCancellationCohort } from './orcad-live-cancellation-cohort'

/** Retires source delivery only; profile installation, routes and completion remain separate. */
export async function retireOrcadLiveSuccessorSourceDeliveries(options: {
  profileDirectory: string
  store: Pick<
    Store,
    | 'getSshTarget'
    | 'listOrcadMigrationSourceCutovers'
    | 'getSshPtyConsumerRecovery'
    | 'upsertSshPtyConsumerRecovery'
  >
  migrationId: string
  signal: AbortSignal
  recoveryOnly: boolean
}) {
  options.signal.throwIfAborted()
  const inspect = () =>
    inspectOrcadLiveCutoverRecovery(options.profileDirectory, options.store).find(
      (entry) => entry.intent.manifest.migrationId === options.migrationId
    )
  const initial = inspect()
  if (initial?.journal?.phase !== 'destination-committed') {
    throw new Error('orcad_live_successor_commit_required')
  }
  const cutover = initial.journal
  const records = new OrcadLiveSourceRetirementRecordStore(options.profileDirectory)
  const record = records.read(initial.intent.identity)
  if (
    !record ||
    serializeOrcadMigrationValue(record.release.cutover) !== serializeOrcadMigrationValue(cutover)
  ) {
    throw new Error('orcad_live_successor_retirement_record_required')
  }
  const evidence = serializeOrcadMigrationValue({ initial, record })
  const assertEvidence = () => {
    options.signal.throwIfAborted()
    if (
      serializeOrcadMigrationValue({
        initial: inspect(),
        record: records.read(record.identity)
      }) !== evidence
    ) {
      throw new Error('orcad_live_successor_retirement_evidence_changed')
    }
  }
  const targetId = cutover.manifest.source.sshTargetId
  return withOrcadCommittedSuccessorProfileAuthority(options, async (committedAuthority) => {
    const authority = {
      assertAuthority: () => {
        committedAuthority.assertAuthority()
        assertEvidence()
      }
    }
    authority.assertAuthority()
    const ordinary = new OrcadLiveSourceCancellationReceiptStore(options.profileDirectory)
    const covered = new OrcadLiveCoveredCancellationReceiptStore(options.profileDirectory)
    const validated = listValidatedOrcadLiveCancellationRecoveryReceipts(options.profileDirectory)
    const prepared = groupOrcadLiveCatalogAdmissions(cutover).flatMap((catalogAdmission) =>
      catalogAdmission.bindings.map(({ identity }) => {
        const receipt = validated.find(
          (entry) =>
            entry.record.sha256 === record.sha256 &&
            samePtyOwnershipTransferIdentity(entry.receipt.identity, identity)
        )?.receipt
        if (receipt) {
          const expected = serializeOrcadMigrationValue(receipt)
          return {
            receipt,
            assertCurrent: () => {
              authority.assertAuthority()
              const saved = (receipt.version === 1 ? ordinary : covered).read(identity)
              const rebound = listValidatedOrcadLiveCancellationRecoveryReceipts(
                options.profileDirectory
              ).find((entry) => samePtyOwnershipTransferIdentity(entry.receipt.identity, identity))
              if (
                serializeOrcadMigrationValue(saved) !== expected ||
                rebound?.record.sha256 !== record.sha256 ||
                serializeOrcadMigrationValue(rebound.receipt) !== expected
              ) {
                throw new Error('orcad_live_successor_receipt_changed')
              }
            }
          }
        }
        const capture = bindOrcadLiveRetirementCapture({
          ...options,
          identity,
          catalogAdmission,
          destinationEnvironmentId: cutover.destinationEnvironmentId,
          assertAuthority: authority.assertAuthority
        })
        return { capture: capture.capture, assertCurrent: capture.assertCurrent }
      })
    )
    const assertPrepared = () => {
      authority.assertAuthority()
      for (const entry of prepared) {
        entry.assertCurrent()
      }
    }
    assertPrepared()
    const missing = prepared.flatMap((entry) => (entry.capture ? [entry.capture] : []))
    const retained = missing.length
      ? await retainOrcadLiveSuccessorSession({
          targetId,
          store: options.store,
          captures: missing,
          signal: options.signal,
          assertAuthority: assertPrepared
        })
      : undefined
    let operationFailure: { error: unknown } | undefined
    let result:
      | {
          phase: 'source-deliveries-retired'
          receipts: (typeof validated)[number]['receipt'][]
        }
      | undefined
    try {
      const readSession = () => retained?.readSession() ?? null
      const admitted = readSession()
      const admittedOwner = serializeOrcadMigrationValue(admitted?.owner)
      const requests = new Map(
        missing.map((capture) => {
          if (!admitted?.resumed || admitted.owner.ownerLease !== capture.identity.ownerLease) {
            throw new Error('orcad_live_successor_session_required')
          }
          return [
            capture,
            parsePtyOwnershipTransferSuccessorRetirementRequest({
              version: 1,
              ...capture.identity,
              successorGeneration: admitted.owner.ownerGeneration,
              savedBaseline: capture.selection,
              retirementRecordSha256: record.sha256,
              recoveryOnly: options.recoveryOnly
            })
          ]
        })
      )
      const assertCohort = () => {
        assertPrepared()
        retained?.assertCurrent()
        if (prepared.some((entry) => !entry.receipt)) {
          const current = readSession()
          if (
            !admitted ||
            !current?.resumed ||
            current.owner.mode !== 'negotiated' ||
            current.mux !== admitted.mux ||
            current.mux.isDisposed() ||
            current.connection !== admitted.connection ||
            current.transportGeneration !== admitted.transportGeneration ||
            serializeOrcadMigrationValue(current.owner) !== admittedOwner
          ) {
            throw new Error('orcad_live_successor_session_changed')
          }
        }
      }
      assertCohort()
      const confirmed: (typeof validated)[number]['receipt'][] = []
      for (const entry of prepared) {
        assertCohort()
        if (entry.receipt) {
          confirmed.push(
            entry.receipt.version === 1
              ? ordinary.persist(entry.receipt)
              : covered.persist(entry.receipt)
          )
        } else {
          const request = requests.get(entry.capture)!
          const retirement = await retireOrcadSuccessorSourceDelivery({
            sourceSshTargetId: targetId,
            request,
            readSession,
            signal: options.signal,
            assertAuthority: assertCohort
          })
          assertCohort()
          const saved = covered.persist(
            createOrcadLiveCoveredCancellationReceipt({
              record,
              capture: entry.capture,
              request,
              retirement
            })
          )
          const expected = serializeOrcadMigrationValue(saved)
          const assertCapture = entry.assertCurrent
          entry.assertCurrent = () => {
            assertCapture()
            if (serializeOrcadMigrationValue(covered.read(saved.identity)) !== expected) {
              throw new Error('orcad_live_successor_receipt_changed')
            }
          }
          confirmed.push(saved)
        }
        assertCohort()
      }
      const cancellation = bindOrcadLiveCancellationCohort(options.profileDirectory, record)
      assertCohort()
      cancellation.assertCancellation(record)
      result = { phase: 'source-deliveries-retired', receipts: confirmed }
    } catch (error) {
      operationFailure = { error }
    }
    try {
      await retained?.dispose()
    } catch (cleanupError) {
      if (operationFailure) {
        throw new AggregateError(
          [operationFailure.error, cleanupError],
          'orcad_live_successor_retirement_cleanup_failed'
        )
      }
      throw cleanupError
    }
    if (operationFailure) {
      throw operationFailure.error
    }
    return result!
  })
}
