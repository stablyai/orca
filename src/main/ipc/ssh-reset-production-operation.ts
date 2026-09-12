import type { SshRelayResetCompletion } from '../ssh/ssh-relay-reset-retirement-record'
import { assertManualSshTargetDestructionAllowed } from './ssh-target-destruction-admission'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'
import {
  assertSshConnectsNotFenced,
  awaitSshTestConnectionProbes,
  connectInFlight,
  resetRelayInFlight
} from './ssh-connect-attempt-registry'
import { clearRelayLostBackoff } from './ssh-relay-lost-backoff'
import { captureProductionSshResetOperation } from './ssh-reset-production-capture'
import { reserveSshResetCapture, sshResetOperationAuthorities } from './ssh-reset-production-state'

type Controller = Awaited<ReturnType<typeof captureProductionSshResetOperation>>
type Slot = {
  reservation: ReturnType<typeof reserveSshResetCapture>
  controller?: Controller
  inFlight?: Promise<SshRelayResetCompletion>
}
const operations = new Map<string, Slot>()

/** Internal integration entrypoint; public rollout remains separately gated. */
export function runProductionSshResetOperation(
  targetId: string,
  signal: AbortSignal
): Promise<SshRelayResetCompletion> {
  signal.throwIfAborted()
  let slot = operations.get(targetId)
  if (slot?.inFlight) {
    return slot.inFlight
  }
  assertSshConnectsNotFenced()
  if (!slot) {
    assertManualSshTargetDestructionAllowed(targetId)
    slot = { reservation: reserveSshResetCapture(targetId) }
    operations.set(targetId, slot)
  }
  const retained = slot
  // Publish before lifecycle callbacks can reenter this entrypoint.
  const running = Promise.resolve()
    .then(() =>
      runTargetLifecycle(targetId, async () => {
        retained.reservation.assertCurrent()
        if (!retained.controller) {
          if (sshResetOperationAuthorities.get(targetId)) {
            throw new Error('ssh_reset_production_controller_missing')
          }
          await connectInFlight.get(targetId)?.promise.catch(() => undefined)
          await awaitSshTestConnectionProbes(targetId)
          signal.throwIfAborted()
          assertSshConnectsNotFenced()
          retained.reservation.assertCurrent()
          clearRelayLostBackoff(targetId)
          retained.controller = await captureProductionSshResetOperation(
            targetId,
            retained.reservation.assertCurrent
          )
        }
        const completion = await retained.controller.run(signal)
        retained.reservation.release()
        if (operations.get(targetId) === retained) {
          operations.delete(targetId)
        }
        return completion
      })
    )
    .catch((error: unknown) => {
      // Initial capture only reads host status; no controller means no begin/drain/reset ran.
      if (!retained.controller && !sshResetOperationAuthorities.get(targetId)) {
        retained.reservation.release()
        if (operations.get(targetId) === retained) {
          operations.delete(targetId)
        }
      }
      throw error
    })
    .finally(() => {
      if (retained.inFlight === running) {
        retained.inFlight = undefined
      }
      if (resetRelayInFlight.get(targetId) === tracked) {
        resetRelayInFlight.delete(targetId)
      }
    })
  const tracked = running.then(() => undefined)
  void tracked.catch(() => undefined)
  resetRelayInFlight.set(targetId, tracked)
  retained.inFlight = running
  return running
}
