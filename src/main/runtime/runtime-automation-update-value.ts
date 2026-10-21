import type { AutomationUpdateInput } from '../../shared/automations-types'
import type { RuntimeAutomationUpdateInput } from './runtime-automation-controller'

export function hasRuntimeAutomationUpdateValue<K extends keyof RuntimeAutomationUpdateInput>(
  updates: RuntimeAutomationUpdateInput,
  key: K
): boolean {
  return Object.hasOwn(updates, key) && updates[key] !== undefined
}

export function copyRuntimeAutomationPatchValues(
  updates: RuntimeAutomationUpdateInput,
  patch: AutomationUpdateInput
): void {
  const keys = [
    'name',
    'prompt',
    'precheck',
    'agentId',
    'extraAgentArgs',
    'runContext',
    'sourceContext',
    'baseBranch',
    'setupDecision',
    'reuseSession',
    'timezone',
    'rrule',
    'dtstart',
    'enabled',
    'missedRunGraceMinutes',
    'webhook'
  ] as const
  for (const key of keys) {
    if (hasRuntimeAutomationUpdateValue(updates, key)) {
      Object.assign(patch, { [key]: updates[key] })
    }
  }
}
