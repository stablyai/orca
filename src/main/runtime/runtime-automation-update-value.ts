import type { AutomationUpdateInput } from '../../shared/automations-types'
import type { RuntimeAutomationUpdateInput } from './runtime-automation-controller'

export function hasRuntimeAutomationUpdateValue<K extends keyof RuntimeAutomationUpdateInput>(
  updates: RuntimeAutomationUpdateInput,
  key: K
): boolean {
  return Object.hasOwn(updates, key) && updates[key] !== undefined
}

export function copyAutomationUpdateValues(
  updates: RuntimeAutomationUpdateInput,
  patch: AutomationUpdateInput
): void {
  const keys = [
    'name',
    'prompt',
    'precheck',
    'agentId',
    'extraAgentArgs',
    'launchSetupPatch',
    'runContext',
    'sourceContext',
    'baseBranch',
    'setupDecision',
    'reuseSession',
    'timezone',
    'rrule',
    'dtstart',
    'enabled',
    'missedRunGraceMinutes'
  ] as const
  for (const key of keys) {
    if (hasRuntimeAutomationUpdateValue(updates, key)) {
      Object.assign(patch, { [key]: updates[key] })
    }
  }
}
