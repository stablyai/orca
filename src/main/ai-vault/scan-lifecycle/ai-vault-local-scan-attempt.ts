import {
  SessionScanInactivity,
  AiVaultScanStalledError
} from '../scan-service/session-scanner-scan-inactivity'
import {
  createScanRecoveryInterest,
  inheritScanRecoveryInterest,
  nextScanObservationOrder,
  scanRecoveryInterest
} from './ai-vault-scan-recovery'
import { throwIfAiVaultScanCancelled, waitForAiVaultScan } from './ai-vault-scan-cancellation'

type Prepare = <T>(read: (activity: () => void) => Promise<T>) => Promise<T>

/** Preparation and child execution share one recovery; late native probes cannot submit work. */
export async function runAiVaultLocalScanAttempt<T>(
  signal: AbortSignal,
  run: (signal: AbortSignal, prepare: Prepare) => Promise<T>
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    throwIfAiVaultScanCancelled(signal)
    const controller = new AbortController()
    const interest = createScanRecoveryInterest(controller.signal)
    const parent = scanRecoveryInterest(signal)
    interest.required = parent?.required ?? 0
    interest.observation = nextScanObservationOrder()
    if (parent) {
      parent.observation = interest.observation
    }
    const release = inheritScanRecoveryInterest(signal, controller.signal)
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    let probeStalled = false
    const prepare: Prepare = async (read) => {
      const inactivity = new SessionScanInactivity(controller.signal, () => {
        probeStalled = true
        controller.abort()
      })
      const activity = () => inactivity.activity(0)
      activity()
      try {
        return await waitForAiVaultScan(read(activity), controller.signal)
      } finally {
        inactivity.dispose()
      }
    }
    try {
      return await run(controller.signal, prepare)
    } catch (error) {
      throwIfAiVaultScanCancelled(signal)
      if (!probeStalled && !(error instanceof AiVaultScanStalledError)) {
        throw error
      }
      if (attempt > 0) {
        throw new Error('AI Vault service stopped making progress.')
      }
    } finally {
      release()
      signal.removeEventListener('abort', abort)
      controller.abort()
    }
  }
}
