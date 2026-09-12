import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import {
  parseSshRelayResetArchive,
  type SshRelayResetArchive
} from '../ssh/ssh-relay-reset-archive'
import { createCompletedSshResetRecovery } from './ssh-reset-completed-recovery'
import { captureSshResetRecoveryResourceGuard } from './ssh-reset-recovery-resource-guard'
import { retainSshResetSuccessorProfileAuthority } from './ssh-reset-successor-profile-authority'
import { getSshResetIntentStore, reserveSshResetRecovery } from './ssh-reset-production-state'
import { assertSshConnectsNotFenced, resetRelayInFlight } from './ssh-connect-attempt-registry'
import { assertSshTargetNotManagedOrPreparing } from './ssh-target-destruction-admission'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'
import { sshRelayResetRecordDigest } from '../ssh/ssh-relay-reset-retirement-record'

type Slot = {
  root: string
  records: ReturnType<typeof getSshResetIntentStore>
  reservation: ReturnType<typeof reserveSshResetRecovery>
  assertProfile: () => void
  historicalDigest: string
  resources?: ReturnType<typeof captureSshResetRecoveryResourceGuard>
  captureFailure?: Error
  controller?: ReturnType<typeof createCompletedSshResetRecovery>
  inFlight?: Promise<SshRelayResetArchive>
  tracked?: Promise<void>
}
const recoveries = new Map<string, Slot>()

/** Internal completed-record recovery only; public rollout and receipt-only recovery stay disabled. */
export function runProductionCompletedSshResetRecovery(targetId: string, signal: AbortSignal) {
  signal.throwIfAborted()
  let slot = recoveries.get(targetId)
  if (slot?.inFlight) {
    return slot.inFlight
  }
  assertSshConnectsNotFenced()
  if (resetRelayInFlight.has(targetId)) {
    throw new Error('ssh_reset_recovery_operation_still_live')
  }
  if (!slot) {
    assertSshTargetNotManagedOrPreparing(targetId)
    const root = getCanonicalUserDataPath()
    const records = getSshResetIntentStore()
    const intent = records.read(targetId)
    if (!intent) {
      throw new Error('ssh_reset_recovery_intent_missing')
    }
    const archive = parseSshRelayResetArchive(
      {
        version: 1,
        intent,
        selection: records.readSelection(intent),
        receipt: records.readReceipt(intent),
        completion: records.readCompletion(intent)
      },
      intent
    )
    const assertProfile = retainSshResetSuccessorProfileAuthority(root, intent, archive.selection)
    slot = {
      root,
      records,
      assertProfile,
      historicalDigest: sshRelayResetRecordDigest(archive),
      reservation: reserveSshResetRecovery(intent)
    }
    recoveries.set(targetId, slot)
  }
  const retained = slot
  const assertReserved = () => {
    if (recoveries.get(targetId) !== retained || getCanonicalUserDataPath() !== retained.root) {
      throw new Error('ssh_reset_recovery_context_changed')
    }
    retained.reservation.assertCurrent()
    retained.assertProfile()
    const { intent } = retained.reservation
    const current = parseSshRelayResetArchive(
      {
        version: 1,
        intent,
        selection: retained.records.readSelection(intent),
        receipt: retained.records.readReceipt(intent),
        completion: retained.records.readCompletion(intent)
      },
      intent
    )
    if (sshRelayResetRecordDigest(current) !== retained.historicalDigest) {
      throw new Error('ssh_reset_recovery_completion_changed')
    }
  }
  const running = Promise.resolve()
    .then(() =>
      runTargetLifecycle(targetId, async () => {
        signal.throwIfAborted()
        assertReserved()
        if (!retained.controller) {
          if (retained.captureFailure) {
            throw retained.captureFailure
          }
          try {
            retained.resources ??= captureSshResetRecoveryResourceGuard({
              intent: retained.reservation.intent,
              selection: retained.reservation.selection,
              assertReserved,
              deferInitialAssertion: true,
              expectedReset: () => {
                if (!retained.tracked) {
                  throw new Error('ssh_reset_recovery_reset_operation_changed')
                }
                return retained.tracked
              }
            })
          } catch (error) {
            retained.captureFailure = error instanceof Error ? error : new Error(String(error))
            throw retained.captureFailure
          }
          const resources = retained.resources
          resources.assertCurrent()
          retained.controller = createCompletedSshResetRecovery({
            intent: retained.reservation.intent,
            records: retained.records,
            leases: resources.leases,
            assertAuthority: assertReserved,
            assertExclusiveProfile: retained.assertProfile,
            assertResourcesAbsent: resources.assertCurrent,
            releaseReservation: (assertRetired) => {
              assertRetired()
              retained.reservation.release()
            }
          })
        }
        const archive = await retained.controller.run(signal)
        if (recoveries.get(targetId) === retained) {
          recoveries.delete(targetId)
        }
        return archive
      })
    )
    .finally(() => {
      if (retained.inFlight === running) {
        retained.inFlight = undefined
      }
      if (resetRelayInFlight.get(targetId) === tracked) {
        resetRelayInFlight.delete(targetId)
      }
      if (retained.tracked === tracked) {
        retained.tracked = undefined
      }
    })
  const tracked = running.then(() => undefined)
  void tracked.catch(() => undefined)
  retained.inFlight = running
  retained.tracked = tracked
  resetRelayInFlight.set(targetId, tracked)
  return running
}
