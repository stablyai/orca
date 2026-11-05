import {
  OrcadCrashLoopError,
  wakeManagedOrcadUnlessCrashLooping
} from '../managed-server/lifecycle/orcad-managed-crash-loop'
import { wakeStoppedManagedOrcad } from '../managed-server/lifecycle/orcad-managed-wake'
import type { OrcadSlotOptions } from './orcad-recovery-slot'

/** Already-active deploys launch nothing; wake that slot only on proven exit, including after reboot. Return whether it was started. */
export async function wakeAlreadyActiveOrcad(
  options: OrcadSlotOptions,
  /** SSH-managed hosts share the crash-loop brake with every other automatic wake. */
  managed?: { environmentId: string; hostLabel: string }
): Promise<boolean> {
  const wake = managed
    ? await wakeManagedOrcadUnlessCrashLooping(managed.environmentId, managed.hostLabel, options)
    : await wakeStoppedManagedOrcad(options)
  if (wake.outcome === 'crash-loop') {
    throw new OrcadCrashLoopError(wake.detail)
  }
  if (wake.outcome === 'recovery-refused') {
    throw new Error(wake.reason)
  }
  return wake.outcome === 'started'
}
