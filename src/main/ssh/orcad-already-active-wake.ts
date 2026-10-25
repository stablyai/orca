import { wakeStoppedManagedOrcad } from '../managed-server/lifecycle/orcad-managed-wake'
import type { OrcadSlotOptions } from './orcad-recovery-slot'

/** Already-active deploys launch nothing; wake that slot only on proven exit, including after reboot. Return whether it was started. */
export async function wakeAlreadyActiveOrcad(options: OrcadSlotOptions): Promise<boolean> {
  const wake = await wakeStoppedManagedOrcad(options)
  if (wake.outcome === 'recovery-refused') {
    throw new Error(wake.reason)
  }
  return wake.outcome === 'started'
}
