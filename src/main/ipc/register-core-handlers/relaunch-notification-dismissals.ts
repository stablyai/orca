import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { settleWithinMs } from '../../startup/quit/quit-teardown-deadline'

// Same cap as the restart path's auth preservation: bookkeeping must not hold Restart on a stalled disk.
export const RELAUNCH_DISMISSAL_CLOSE_TIMEOUT_MS = 2_000

export async function closeNotificationDismissalsBeforeRelaunch(
  runtime: OrcaRuntimeService
): Promise<void> {
  const result = await settleWithinMs(
    runtime.closeNotificationDismissals(),
    RELAUNCH_DISMISSAL_CLOSE_TIMEOUT_MS
  )
  if (result.outcome === 'timed-out') {
    console.warn('[notifications] Relaunching before dismissal recovery state finished saving')
  }
}
