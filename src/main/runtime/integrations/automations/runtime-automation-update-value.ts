import type { AutomationUpdateInput } from '../../../../shared/automations/automation-definition'
import type { RuntimeAutomationUpdateInput } from './runtime-automation-run-context'
import { RUNTIME_AUTOMATION_PATCH_KEYS } from './runtime-automation-patch-keys'

export function hasRuntimeAutomationUpdateValue<K extends keyof RuntimeAutomationUpdateInput>(
  updates: RuntimeAutomationUpdateInput,
  key: K
): boolean {
  return Object.hasOwn(updates, key) && updates[key] !== undefined
}

/** The fields an update sets, as they are; the target and the bot's rules are worked out apart. */
export function copyRuntimeAutomationPatchValues(
  updates: RuntimeAutomationUpdateInput,
  patch: AutomationUpdateInput
): void {
  const keys = [...RUNTIME_AUTOMATION_PATCH_KEYS, 'bot', 'on', 'once', 'timezoneExplicit'] as const
  for (const key of keys) {
    if (hasRuntimeAutomationUpdateValue(updates, key)) {
      Object.assign(patch, { [key]: updates[key] })
    }
  }
}
