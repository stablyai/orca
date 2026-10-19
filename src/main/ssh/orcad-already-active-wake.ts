import { wakeStoppedManagedOrcad } from '../managed-server/lifecycle/orcad-managed-wake'
import type { OrcadSlotOptions } from './orcad-recovery-slot'

/**
 * After a deploy found its own version already active: it launches nothing, and that slot may have
 * stopped since (a kill, a host reboot), so start it on proven exit. True when this call started it.
 */
export async function wakeAlreadyActiveOrcad(options: OrcadSlotOptions): Promise<boolean> {
  const wake = await wakeStoppedManagedOrcad(options)
  if (wake.outcome === 'recovery-refused') {
    throw new Error(wake.reason)
  }
  return wake.outcome === 'started'
}
