import { vi } from 'vitest'
import type { Store } from '../../persistence/loading-store/store'
import type { AutomationLauncher } from '../launch/automation-launch'
import { AutomationService } from '../automation-service'

export const TICK_MS = 60_000

/** A started service whose terminal launcher is available, as on serve or a desktop with its window open. */
export function startedAutomationService(
  store: Store,
  launch: AutomationLauncher = vi.fn(async () => ({
    workspaceId: 'wt-1',
    terminalSessionId: 'tab-1'
  }))
): AutomationService {
  const service = new AutomationService(store, {
    tickMs: TICK_MS,
    terminalLauncher: { launch, available: () => true }
  })
  service.start()
  return service
}

/** Fire the next scheduler tick at `when`; needs fake timers and a started service. */
export async function tickAt(when: string | number): Promise<void> {
  vi.setSystemTime(new Date(when).getTime() - TICK_MS)
  await vi.advanceTimersByTimeAsync(TICK_MS)
}
