import type { GlobalSettings } from '../../../shared/global-settings-types'
import { retireAtRestCommandSettings } from '../../native-chat/agent-session-wire/at-rest-command-context'
import type { SettingsMutationOperations } from './settings-update'

export function notifyListenersForSettingsChanges(
  operations: SettingsMutationOperations,
  previousSettings: GlobalSettings,
  sanitizedUpdates: Partial<GlobalSettings>,
  notifyListeners: boolean,
  originWebContentsId?: number
): void {
  const changedUpdates = {} as Partial<GlobalSettings> & Record<string, unknown>
  for (const key of Object.keys(sanitizedUpdates) as (keyof GlobalSettings)[]) {
    if (!Object.is(previousSettings[key], operations.state.settings[key])) {
      changedUpdates[String(key)] = operations.state.settings[key]
    }
  }
  retireAtRestCommandSettings(Object.keys(changedUpdates))
  if (notifyListeners && Object.keys(changedUpdates).length > 0) {
    operations.notifySettingsChanged(changedUpdates, originWebContentsId)
  }
}
