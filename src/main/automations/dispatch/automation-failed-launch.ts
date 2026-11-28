import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import type { AutomationService } from '../automation-service'
import type { Store } from '../../persistence/loading-store/store'
import { AutomationDispatchCancelledError } from './automation-dispatch-cancelled-error'

/** Only an unlaunched run of an active generation fails; a flush error after launch is not a launch failure. */
export async function recordFailedLaunch(
  store: Pick<Store, 'listAutomationRuns'>,
  run: AutomationRun,
  active: boolean,
  error: unknown,
  markDispatchResult: AutomationService['markDispatchResult']
): Promise<void> {
  const current = store.listAutomationRuns(run.automationId).find((r) => r.id === run.id)
  const unlaunched = current?.status === 'pending' || current?.status === 'dispatching'
  if (unlaunched && active && !(error instanceof AutomationDispatchCancelledError)) {
    const message = error instanceof Error ? error.message : String(error)
    await markDispatchResult({ runId: run.id, status: 'dispatch_failed', error: message })
  }
}
