import type { GlobalSettings } from '../../../shared/global-settings-types'
import { notifyListenersForSettingsChanges } from './settings-update-notify'
import { sanitizeSettingsFieldUpdates } from './settings-update-sanitize'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  mergeLegacyCommitMessageAiIntoSourceControlAi,
  normalizeSourceControlAiSettings,
  projectSourceControlAiToLegacyCommitMessageAi
} from '../../../shared/source-control-ai'
import {
  PROTECTED_SECRET_SLOT,
  type ProtectedSecretPersistence
} from '../../protected-secret-persistence'
import { normalizeNotificationSettings } from './onboarding-normalization'
import { retireLegacyInstructionsForClearedTextActionRecipes } from './source-control-settings'
import { stripRetiredGlobalSettings } from './terminal-settings-migrations'

export type SettingsMutationOperations = {
  state: PersistedState
  bumpLocalWorktreeScanGeneration: (repoId: string) => void
  removeRetainedBlob: ProtectedSecretPersistence['removeRetainedBlob']
  scheduleSave: () => void
  notifySettingsChanged: (updates: Partial<GlobalSettings>, originWebContentsId?: number) => void
}

export function updateSettings(
  operations: SettingsMutationOperations,
  updates: Partial<GlobalSettings>,
  options: { notifyListeners?: boolean; originWebContentsId?: number } = {}
): GlobalSettings {
  const sanitizedUpdates = stripRetiredGlobalSettings(updates)
  sanitizeSettingsFieldUpdates(operations, updates, sanitizedUpdates)
  const mergedTelemetry =
    sanitizedUpdates.telemetry !== undefined
      ? { ...operations.state.settings.telemetry, ...sanitizedUpdates.telemetry }
      : operations.state.settings.telemetry
  if ('sourceControlAi' in sanitizedUpdates) {
    sanitizedUpdates.sourceControlAi = retireLegacyInstructionsForClearedTextActionRecipes(
      sanitizedUpdates.sourceControlAi,
      operations.state.settings
    )
    const normalizedSourceControlAi = normalizeSourceControlAiSettings(
      sanitizedUpdates.sourceControlAi,
      operations.state.settings.commitMessageAi
    )
    sanitizedUpdates.sourceControlAi = normalizedSourceControlAi
    sanitizedUpdates.commitMessageAi = projectSourceControlAiToLegacyCommitMessageAi(
      normalizedSourceControlAi,
      operations.state.settings.commitMessageAi
    )
  } else if ('commitMessageAi' in sanitizedUpdates) {
    sanitizedUpdates.sourceControlAi = mergeLegacyCommitMessageAiIntoSourceControlAi(
      operations.state.settings.sourceControlAi,
      sanitizedUpdates.commitMessageAi
    )
  }
  const previousSettings = operations.state.settings
  operations.state.settings = {
    ...operations.state.settings,
    ...sanitizedUpdates,
    notifications: normalizeNotificationSettings({
      ...operations.state.settings.notifications,
      ...sanitizedUpdates.notifications
    }),
    ...(mergedTelemetry !== undefined ? { telemetry: mergedTelemetry } : {})
  }
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
  notifyListenersForSettingsChanges(
    operations,
    previousSettings,
    sanitizedUpdates,
    options.notifyListeners === true,
    options.originWebContentsId
  )
  return operations.state.settings
}
