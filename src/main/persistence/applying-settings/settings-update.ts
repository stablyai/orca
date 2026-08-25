import type { GlobalSettings } from '../../../shared/global-settings-types'
import { normalizeDisabledTuiAgents } from '../../../shared/tui-agent-selection'
import {
  normalizeTuiAgentArgsRecord,
  normalizeTuiAgentEnvRecord
} from '../../../shared/tui-agent-launch-defaults'
import { normalizeTerminalQuickCommands } from '../../../shared/terminal-quick-commands'
import { normalizeTerminalCustomThemes } from '../../../shared/terminal-custom-themes'
import { normalizeTerminalCursorStyleDefault } from '../../../shared/terminal-cursor-style-settings'
import { normalizeDesktopTerminalScrollbackRows } from '../../../shared/terminal-scrollback-policy'
import { normalizeTaskProviderSettings } from '../../../shared/task-providers'
import { normalizeOpenInApplications } from '../../../shared/open-in-applications'
import { normalizeTerminalShortcutPolicy } from '../../../shared/keybindings'
import { normalizeSourceControlGroupOrder } from '../../../shared/source-control-group-order'
import { normalizeAppIconId } from '../../../shared/app-icon'
import { normalizeUiLanguage } from '../../../shared/ui-language'
import { normalizeWorktreeVisibilityDefaults } from '../../../shared/external-worktree-visibility'
import { normalizePRBotAuthorOverrides } from '../../../shared/pr-bot-author-overrides'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  addMobilePairingCustomAddress,
  normalizeMobilePairingCustomAddress,
  normalizeMobilePairingCustomAddresses
} from '../../../shared/mobile-pairing-custom-address'
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
import {
  buildWorkspaceDirHistoryForUpdate,
  stripRetiredGlobalSettings
} from './terminal-settings-migrations'

export type SettingsMutationOperations = {
  state: PersistedState
  removeRetainedBlob: (
    slot: Parameters<ProtectedSecretPersistence['removeRetainedBlob']>[0]
  ) => void
  scheduleSave: () => void
  notifySettingsChanged: (updates: Partial<GlobalSettings>, originWebContentsId?: number) => void
}

export function updateSettings(
  operations: SettingsMutationOperations,
  updates: Partial<GlobalSettings>,
  options: { notifyListeners?: boolean; originWebContentsId?: number } = {}
): GlobalSettings {
  const sanitizedUpdates = stripRetiredGlobalSettings(updates)
  if ('opencodeSessionCookie' in updates && !updates.opencodeSessionCookie) {
    operations.removeRetainedBlob(PROTECTED_SECRET_SLOT.opencodeSessionCookie)
  }
  if ('httpProxyUrl' in updates && !updates.httpProxyUrl) {
    operations.removeRetainedBlob(PROTECTED_SECRET_SLOT.httpProxyUrl)
  }
  // Why: coerce to boolean here (not the IPC edge) so every write path is covered and a truthy non-bool can't persist as "tray-minimize on".
  if ('minimizeToTrayOnClose' in updates) {
    sanitizedUpdates.minimizeToTrayOnClose = updates.minimizeToTrayOnClose === true
  }
  if ('showMenuBarIcon' in updates) {
    sanitizedUpdates.showMenuBarIcon = updates.showMenuBarIcon === true
  }
  // Why: the artifact publish capability must be an exact boolean on disk; no truthy value grants it.
  if ('artifactSharingEnabled' in updates) {
    sanitizedUpdates.artifactSharingEnabled = updates.artifactSharingEnabled === true
  }
  if ('agentSkillSharingEnabled' in updates) {
    sanitizedUpdates.agentSkillSharingEnabled = updates.agentSkillSharingEnabled === true
  }
  if ('disabledTuiAgents' in updates) {
    sanitizedUpdates.disabledTuiAgents = normalizeDisabledTuiAgents(updates.disabledTuiAgents)
  }
  if ('worktreeVisibilityDefaults' in updates) {
    sanitizedUpdates.worktreeVisibilityDefaults = {
      ...operations.state.settings.worktreeVisibilityDefaults,
      ...(normalizeWorktreeVisibilityDefaults(updates.worktreeVisibilityDefaults) ?? {
        external: 'hide'
      })
    }
  }
  if ('agentDefaultArgs' in updates) {
    sanitizedUpdates.agentDefaultArgs = normalizeTuiAgentArgsRecord(updates.agentDefaultArgs)
    sanitizedUpdates.agentYoloDefaultsMigrated = true
  }
  if ('agentDefaultEnv' in updates) {
    sanitizedUpdates.agentDefaultEnv = normalizeTuiAgentEnvRecord(updates.agentDefaultEnv)
    sanitizedUpdates.agentYoloDefaultsMigrated = true
  }
  if ('terminalQuickCommands' in updates) {
    sanitizedUpdates.terminalQuickCommands = normalizeTerminalQuickCommands(
      updates.terminalQuickCommands
    )
  }
  if ('terminalCustomThemes' in updates) {
    sanitizedUpdates.terminalCustomThemes = normalizeTerminalCustomThemes(
      updates.terminalCustomThemes
    )
  }
  if ('terminalCursorStyle' in updates) {
    Object.assign(
      sanitizedUpdates,
      normalizeTerminalCursorStyleDefault(
        { terminalCursorStyle: updates.terminalCursorStyle },
        { preserveExplicitValue: true }
      )
    )
  }
  if ('terminalScrollbackRows' in updates) {
    sanitizedUpdates.terminalScrollbackRows = normalizeDesktopTerminalScrollbackRows(
      updates.terminalScrollbackRows
    )
  }
  if (
    'terminalTuiScrollSensitivity' in updates ||
    'terminalTuiScrollSensitivityDefaultedToOne' in updates
  ) {
    sanitizedUpdates.terminalTuiScrollSensitivityDefaultedToOne = true
  }
  if ('visibleTaskProviders' in updates || 'defaultTaskSource' in updates) {
    const taskProviderSettings = normalizeTaskProviderSettings({
      visibleTaskProviders:
        'visibleTaskProviders' in updates
          ? updates.visibleTaskProviders
          : operations.state.settings.visibleTaskProviders,
      defaultTaskSource:
        'defaultTaskSource' in updates
          ? updates.defaultTaskSource
          : operations.state.settings.defaultTaskSource
    })
    sanitizedUpdates.defaultTaskSource = taskProviderSettings.defaultTaskSource
    sanitizedUpdates.visibleTaskProviders = taskProviderSettings.visibleTaskProviders
    if ('visibleTaskProviders' in updates) {
      sanitizedUpdates.visibleTaskProvidersDefaultedForJira = true
    }
  }
  if ('autoRenameBranchFromWork' in updates || 'autoRenameBranchFromWorkDefaultedOn' in updates) {
    sanitizedUpdates.autoRenameBranchFromWorkDefaultedOn = true
  }
  if ('openInApplications' in updates) {
    sanitizedUpdates.openInApplications = normalizeOpenInApplications(updates.openInApplications)
  }
  if ('terminalShortcutPolicy' in updates) {
    sanitizedUpdates.terminalShortcutPolicy = normalizeTerminalShortcutPolicy(
      updates.terminalShortcutPolicy
    )
  }
  if ('sourceControlGroupOrder' in updates) {
    sanitizedUpdates.sourceControlGroupOrder = normalizeSourceControlGroupOrder(
      updates.sourceControlGroupOrder
    )
  }
  if ('appIcon' in updates) {
    sanitizedUpdates.appIcon = normalizeAppIconId(updates.appIcon)
  }
  if ('uiLanguage' in updates) {
    sanitizedUpdates.uiLanguage = normalizeUiLanguage(updates.uiLanguage)
  }
  if ('prBotAuthorOverrides' in updates) {
    // Why: every writer (desktop IPC, web RPC, migrations) hits this boundary, so the persisted list stays bounded and well-formed.
    sanitizedUpdates.prBotAuthorOverrides = normalizePRBotAuthorOverrides(
      updates.prBotAuthorOverrides
    )
  }
  if ('mobilePairingCustomAddress' in updates) {
    sanitizedUpdates.mobilePairingCustomAddress = normalizeMobilePairingCustomAddress(
      updates.mobilePairingCustomAddress
    )
  }
  if ('mobilePairingCustomAddresses' in updates) {
    sanitizedUpdates.mobilePairingCustomAddresses = normalizeMobilePairingCustomAddresses(
      updates.mobilePairingCustomAddresses
    )
  }
  if (
    'mobilePairingCustomAddress' in sanitizedUpdates ||
    'mobilePairingCustomAddresses' in sanitizedUpdates
  ) {
    const mobilePairingCustomAddress =
      'mobilePairingCustomAddress' in sanitizedUpdates
        ? sanitizedUpdates.mobilePairingCustomAddress
        : operations.state.settings.mobilePairingCustomAddress
    if (mobilePairingCustomAddress) {
      sanitizedUpdates.mobilePairingCustomAddresses = addMobilePairingCustomAddress(
        sanitizedUpdates.mobilePairingCustomAddresses ??
          operations.state.settings.mobilePairingCustomAddresses ??
          [],
        mobilePairingCustomAddress
      )
    }
  }
  const historyWithPreviousLayout = buildWorkspaceDirHistoryForUpdate(
    operations.state.settings,
    sanitizedUpdates
  )
  if (historyWithPreviousLayout) {
    sanitizedUpdates.workspaceDirHistory = historyWithPreviousLayout
  }
  // Why deep-merge telemetry: a partial update (e.g. flipping only `optedIn`) must not clobber siblings like `installId`.
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
  operations.scheduleSave()
  const changedUpdates = {} as Partial<GlobalSettings> & Record<string, unknown>
  for (const key of Object.keys(sanitizedUpdates) as (keyof GlobalSettings)[]) {
    if (!Object.is(previousSettings[key], operations.state.settings[key])) {
      changedUpdates[String(key)] = operations.state.settings[key]
    }
  }
  if (options.notifyListeners === true && Object.keys(changedUpdates).length > 0) {
    operations.notifySettingsChanged(changedUpdates, options.originWebContentsId)
  }
  return operations.state.settings
}
