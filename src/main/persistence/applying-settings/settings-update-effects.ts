import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { PROTECTED_SECRET_SLOT } from '../../credentials/protected-secret-persistence'
import { retireAtRestCommandSettings } from '../../native-chat/agent-session-wire/options/at-rest-command-context'
import { createAgentModelCatalogSettingsExpiry } from '../../native-chat/agent-model-catalog/agent-model-catalog-account-expiry'
import { agentModelCatalogStore } from '../../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { SettingsMutationOperations, SettingsUpdateOptions } from './settings-update'

export function publishSettingsUpdate(
  operations: SettingsMutationOperations,
  updates: Partial<GlobalSettings>,
  sanitizedUpdates: Partial<GlobalSettings>,
  previousSettings: GlobalSettings,
  options: SettingsUpdateOptions
): void {
  if ('opencodeSessionCookie' in updates && !updates.opencodeSessionCookie) {
    operations.removeRetainedBlob(PROTECTED_SECRET_SLOT.opencodeSessionCookie)
  }
  if ('httpProxyUrl' in updates && !updates.httpProxyUrl) {
    operations.removeRetainedBlob(PROTECTED_SECRET_SLOT.httpProxyUrl)
  }
  if (
    !Object.is(
      previousSettings.localWindowsRuntimeDefault,
      operations.state.settings.localWindowsRuntimeDefault
    )
  ) {
    for (const repoId of new Set(operations.state.repos.map(({ id }) => id))) {
      operations.bumpLocalWorktreeScanGeneration(repoId)
    }
  }
  operations.scheduleSave()
  const previousEntries = new Map(Object.entries(previousSettings))
  const currentEntries = new Map(Object.entries(operations.state.settings))
  const changedUpdates = Object.fromEntries(
    Object.keys(sanitizedUpdates)
      .filter((key) => !Object.is(previousEntries.get(key), currentEntries.get(key)))
      .map((key) => [key, currentEntries.get(key)])
  )
  createAgentModelCatalogSettingsExpiry(agentModelCatalogStore, previousSettings)(
    changedUpdates,
    operations.state.settings
  )
  retireAtRestCommandSettings(Object.keys(changedUpdates))
  if (Object.keys(changedUpdates).length === 0) {
    return
  }
  // Persisted listeners are isolated from each other, so they run before ones that may throw.
  operations.notifySettingsPersisted(changedUpdates, options.origin)
  if (options.notifyListeners === true) {
    operations.notifySettingsChanged(changedUpdates, options.originWebContentsId)
  }
}
