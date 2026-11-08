import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { Store } from '../persistence/loading-store/store'
import type { AutomationService } from './service'

/** Run now acknowledges with the pending row; wait for its lane and read what the launch saved. */
export async function runNowSettled(
  service: Pick<AutomationService, 'runNow' | 'runInAutomationLane'>,
  store: Pick<Store, 'listAutomationRuns'>,
  automationId: string
): Promise<AutomationRun> {
  const run = await service.runNow(automationId)
  await service.runInAutomationLane(automationId, async () => undefined)
  return store.listAutomationRuns(automationId).find((entry) => entry.id === run.id) ?? run
}
