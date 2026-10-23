import type { GlobalSettings } from '../../../shared/global-settings-types'
import { mergeUsageRequestEnabled } from '../../../shared/usage-request-policy'
import { stripRetiredGlobalSettings } from './terminal-settings-migrations'
import type { SettingsMutationOperations } from './settings-update'

export function sanitizeUsageRequestSettingsUpdate(
  operations: Pick<SettingsMutationOperations, 'state'>,
  updates: Partial<GlobalSettings>
): Partial<GlobalSettings> {
  const sanitized = stripRetiredGlobalSettings(updates)
  if ('usageRequestEnabled' in updates) {
    sanitized.usageRequestEnabled = mergeUsageRequestEnabled(
      operations.state.settings.usageRequestEnabled,
      updates.usageRequestEnabled
    )
  }
  return sanitized
}
