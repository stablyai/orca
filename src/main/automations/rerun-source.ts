import { isFinalAutomationRunStatus, type AutomationRun } from '../../shared/automations-types'
import type { Store } from '../persistence'

export function resolveAutomationRerunSource(
  store: Pick<Store, 'listAutomationRuns'>,
  automationId: string,
  sourceRunId: string | undefined
): AutomationRun | undefined {
  if (sourceRunId === undefined) {
    return undefined
  }
  const source = store.listAutomationRuns(automationId).find((entry) => entry.id === sourceRunId)
  if (!source) {
    throw new Error('The selected automation run was not found. Refresh its history and try again.')
  }
  if (!isFinalAutomationRunStatus(source.status)) {
    throw new Error('The selected automation run is still running.')
  }
  return source
}
