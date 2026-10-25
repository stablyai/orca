import type { Store } from '../persistence'
import type { Automation, AutomationPrecheckResult } from '../../shared/automations-types'
import type { AutomationRunTargetResult } from './run-target-resolution'
import { failedPrecheckResult, runAutomationPrecheck } from './precheck-runner'

export async function runStoredAutomationPrecheck({
  store,
  automationId,
  runId,
  resolveTarget
}: {
  store: Store
  automationId: string
  runId: string
  resolveTarget: (automation: Automation) => AutomationRunTargetResult
}): Promise<AutomationPrecheckResult | null> {
  const automation = store.listAutomations().find((entry) => entry.id === automationId)
  if (!automation) {
    throw new Error('Automation not found.')
  }
  const run = store.listAutomationRuns(automationId).find((entry) => entry.id === runId)
  if (!run) {
    throw new Error('Automation run not found.')
  }
  if (run.trigger !== 'scheduled' || !automation.precheck) {
    return null
  }
  const target = resolveTarget(automation)
  if (!target.ok) {
    return failedPrecheckResult(automation.precheck, Date.now(), target.error)
  }
  return await runAutomationPrecheck({
    precheck: automation.precheck,
    target:
      automation.executionTargetType === 'ssh'
        ? { type: 'ssh', cwd: target.cwd, connectionId: automation.executionTargetId }
        : { type: 'local', cwd: target.cwd }
  })
}
