import { normalizeAgentNativeChatPermissionModes } from '../../../shared/agent-chat-permission-mode'
import { normalizeNativeChatAppearanceSettings } from '../../../shared/native-chat-appearance-settings'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { normalizeDisabledTuiAgents } from '../../../shared/tui-agent-selection'
import { normalizeNativeChatProviderChoices } from '../../../shared/native-chat-providers'
import { resolveNestedWorkerMaxDepth } from '../../../shared/nested-worker-depth'
import {
  normalizeTuiAgentArgsRecord,
  normalizeTuiAgentEnvRecord
} from '../../../shared/tui-agent-launch-defaults'
import { normalizeTerminalQuickCommands } from '../../../shared/terminal-quick-commands'
import { assertTerminalQuickCommandsStorable } from '../../../shared/terminal-quick-command-prompt-limit'
import { normalizeTerminalCustomThemes } from '../../../shared/terminal-custom-themes'
import { normalizeTerminalDefaultShell } from '../../../shared/terminal-default-shell'
import { normalizeTerminalCursorStyleDefault } from '../../../shared/terminal-cursor-style-settings'
import { normalizeDesktopTerminalScrollbackRows } from '../../../shared/terminal-scrollback-policy'
import { normalizeTerminalMinimumContrastRatio } from '../../../shared/terminal-minimum-contrast-settings'
import { normalizeTaskProviderSettings } from '../../../shared/task-providers'
import { normalizeOpenInApplications } from '../../../shared/open-in-applications'
import { normalizeTerminalShortcutPolicy } from '../../../shared/keybindings'
import { normalizeSourceControlGroupOrder } from '../../../shared/source-control-group-order'
import { normalizeAppIconId } from '../../../shared/app-icon'
import { normalizeUiLanguage } from '../../../shared/ui-language'
import { normalizeWorktreeVisibilityDefaults } from '../../../shared/external-worktree-visibility'
import { normalizePRBotAuthorOverrides } from '../../../shared/pr-bot-author-overrides'
import { normalizeMachineName } from '../../../shared/machine-name'
import {
  addMobilePairingCustomAddress,
  normalizeMobilePairingCustomAddress,
  normalizeMobilePairingCustomAddresses
} from '../../../shared/mobile-pairing-custom-address'
import { buildWorkspaceDirHistoryForUpdate } from './terminal-settings-migrations'
import type { SettingsMutationOperations } from './settings-update'

export function sanitizeSettingsFieldUpdates(
  operations: SettingsMutationOperations,
  updates: Partial<GlobalSettings>,
  sanitizedUpdates: Partial<GlobalSettings>
): void {
  const linkBehavior = updates.terminalLinkClickBehavior
  if (linkBehavior === 'actions' || linkBehavior === 'open' || linkBehavior === 'none') {
    sanitizedUpdates.terminalLinkActionPopoverEnabled = linkBehavior === 'actions'
  }
  if ('minimizeToTrayOnClose' in updates) {
    sanitizedUpdates.minimizeToTrayOnClose = updates.minimizeToTrayOnClose === true
  }
  if ('showMenuBarIcon' in updates) {
    sanitizedUpdates.showMenuBarIcon = updates.showMenuBarIcon === true
  }
  if ('artifactSharingEnabled' in updates) {
    sanitizedUpdates.artifactSharingEnabled = updates.artifactSharingEnabled === true
  }
  if ('agentSkillSharingEnabled' in updates) {
    sanitizedUpdates.agentSkillSharingEnabled = updates.agentSkillSharingEnabled === true
  }
  if ('nestedWorkerMaxDepth' in updates) {
    sanitizedUpdates.nestedWorkerMaxDepth = resolveNestedWorkerMaxDepth({
      nestedWorkerMaxDepth: updates.nestedWorkerMaxDepth
    })
  }
  if ('nativeChatPermissionMode' in updates || 'agentNativeChatPermissionModes' in updates) {
    sanitizedUpdates.agentNativeChatPermissionModes = normalizeAgentNativeChatPermissionModes(
      updates.agentNativeChatPermissionModes
    )
  }
  if ('nativeChatAppearance' in updates) {
    sanitizedUpdates.nativeChatAppearance = normalizeNativeChatAppearanceSettings(
      updates.nativeChatAppearance
    )
  }
  if ('disabledTuiAgents' in updates) {
    sanitizedUpdates.disabledTuiAgents = normalizeDisabledTuiAgents(updates.disabledTuiAgents)
  }
  if ('nativeChatProviders' in updates) {
    sanitizedUpdates.nativeChatProviders = normalizeNativeChatProviderChoices(
      updates.nativeChatProviders
    )
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
    const terminalQuickCommands = normalizeTerminalQuickCommands(updates.terminalQuickCommands)
    assertTerminalQuickCommandsStorable(terminalQuickCommands)
    sanitizedUpdates.terminalQuickCommands = terminalQuickCommands
  }
  if ('terminalDefaultShell' in updates) {
    sanitizedUpdates.terminalDefaultShell = normalizeTerminalDefaultShell(
      updates.terminalDefaultShell
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
  if ('terminalMinimumContrastRatio' in updates) {
    sanitizedUpdates.terminalMinimumContrastRatio = normalizeTerminalMinimumContrastRatio(
      updates.terminalMinimumContrastRatio
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
      sanitizedUpdates.visibleTaskProvidersDefaultedForClickUp = true
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
    sanitizedUpdates.prBotAuthorOverrides = normalizePRBotAuthorOverrides(
      updates.prBotAuthorOverrides
    )
  }
  if ('machineName' in updates) {
    sanitizedUpdates.machineName = normalizeMachineName(updates.machineName)
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
}
