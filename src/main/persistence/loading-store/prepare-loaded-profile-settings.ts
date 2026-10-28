import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import { deriveGlobalWindowsRuntimeDefaultFromLegacySettings } from '../../../shared/project-execution-runtime'
import { normalizeTaskProviderSettings } from '../../../shared/task-providers'
import { normalizeAutoRenameBranchFromWorkDefaultOn } from '../../../shared/auto-rename-branch-from-work-settings'
import {
  addMobilePairingCustomAddress,
  normalizeMobilePairingCustomAddress,
  normalizeMobilePairingCustomAddresses
} from '../../../shared/mobile-pairing-custom-address'
import { normalizeSourceControlGroupOrder } from '../../../shared/source-control-group-order'
import { normalizeProjectGroups } from '../../../shared/project-groups'
import { normalizeDisabledTuiAgents } from '../../../shared/tui-agent-selection'
import { hasUnsupportedTuiAgentArgs } from '../../../shared/tui-agent-launch-defaults'
import { normalizeTerminalCursorStyleDefault } from '../../../shared/terminal-cursor-style-settings'
import { normalizeTerminalLineHeight } from '../../../shared/terminal-line-height-settings'
import { migratePortugueseUiLanguageOnLoad } from '../../../shared/portuguese-ui-language-migration'
import { migrateAgentYoloDefaults } from '../applying-settings/terminal-settings-migrations'
import { hasTypedAgentPermission } from '../../../shared/tui-agent-permission-choice'
import { migrateAgentPermissionChoice } from '../../../shared/tui-agent-permission-lift'
import {
  normalizeLoadedOnboardingState,
  normalizeNotificationSettings,
  persistedNotificationSettingsRepaired
} from '../applying-settings/onboarding-normalization'

export type PreparedLoadedProfileSettings = {
  migratedPortugueseUiLanguage: Pick<
    GlobalSettings,
    'uiLanguage' | 'uiLanguagePortugueseMigrationApplied'
  >
  migratedExperimentalActivity: GlobalSettings['experimentalActivity']
  migratedAutoRenameBranchFromWork: Pick<
    GlobalSettings,
    'autoRenameBranchFromWork' | 'autoRenameBranchFromWorkDefaultedOn'
  >
  migratedTerminalCursorStyle: Pick<
    GlobalSettings,
    'terminalCursorStyle' | 'terminalCursorStyleDefaultedToBlock'
  >
  migratedTerminalLineHeight: GlobalSettings['terminalLineHeight']
  terminalRightClickToPasteDefaultedForPlatform: boolean
  taskProviderSettings: Pick<GlobalSettings, 'defaultTaskSource' | 'visibleTaskProviders'>
  primarySelectionDefaultedForLinux: boolean
  primarySelectionDefaultedForTerminalDefaults: boolean
  migratePrimarySelectionPlatformDefault: boolean
  stampPrimarySelectionTerminalDefaults: boolean
  migratedDisabledTuiAgents: GlobalSettings['disabledTuiAgents']
  migratedAgentYoloDefaults: Pick<
    GlobalSettings,
    'agentDefaultArgs' | 'agentDefaultEnv' | 'agentYoloDefaultsMigrated'
  >
  migratedAgentPermission: ReturnType<typeof migrateAgentPermissionChoice>
  migratedWindowsRuntimeDefault: GlobalSettings['localWindowsRuntimeDefault']
  migratedLocalAccountRuntime: GlobalSettings['localAccountRuntime']
  loadedCompactWorktreeCards: boolean
  mobilePairingCustomAddress: GlobalSettings['mobilePairingCustomAddress']
  mobilePairingCustomAddresses: GlobalSettings['mobilePairingCustomAddresses']
  normalizedNotifications: GlobalSettings['notifications']
  normalizedSourceControlGroupOrder: GlobalSettings['sourceControlGroupOrder']
  normalizedOnboarding: PersistedState['onboarding']
  normalizedProjectGroups: ProjectGroup[]
}

export function prepareLoadedProfileSettings(
  parsed: PersistedState,
  defaults: PersistedState,
  markNeedsSave: () => void
): PreparedLoadedProfileSettings {
  const migratedPortugueseUiLanguage = migratePortugueseUiLanguageOnLoad(parsed.settings)
  if (
    parsed.settings?.uiLanguage !== migratedPortugueseUiLanguage.uiLanguage ||
    parsed.settings?.uiLanguagePortugueseMigrationApplied !== true
  ) {
    markNeedsSave()
  }
  const experimentalActivityDefaultedOffForAllUsers =
    parsed.settings?.experimentalActivityDefaultedOffForAllUsers === true
  // Preserve the pre-graduation Agents-tab rollout boundary.
  const migratedExperimentalActivity = experimentalActivityDefaultedOffForAllUsers
    ? (parsed.settings?.experimentalActivity ?? false)
    : false
  const autoRenameBranchFromWorkDefaultedOn =
    parsed.settings?.autoRenameBranchFromWorkDefaultedOn === true
  // Migrate default-on once so subsequent opt-outs survive.
  const migratedAutoRenameBranchFromWork = normalizeAutoRenameBranchFromWorkDefaultOn(
    parsed.settings
  )
  const migratedTerminalCursorStyle = normalizeTerminalCursorStyleDefault(parsed.settings)
  if (
    parsed.settings?.terminalCursorStyle !== migratedTerminalCursorStyle.terminalCursorStyle ||
    parsed.settings?.terminalCursorStyleDefaultedToBlock !== true
  ) {
    markNeedsSave()
  }
  const migratedTerminalLineHeight = normalizeTerminalLineHeight(
    parsed.settings?.terminalLineHeight
  )
  const terminalRightClickToPasteDefaultedForPlatform =
    parsed.settings?.terminalRightClickToPasteDefaultedForPlatform === true
  if (!terminalRightClickToPasteDefaultedForPlatform) {
    markNeedsSave()
  }
  if (
    parsed.settings?.terminalLineHeight !== undefined &&
    parsed.settings.terminalLineHeight !== migratedTerminalLineHeight
  ) {
    markNeedsSave()
  }
  const rawTaskProviderSettings = normalizeTaskProviderSettings({
    visibleTaskProviders: parsed.settings?.visibleTaskProviders,
    defaultTaskSource: parsed.settings?.defaultTaskSource
  })
  const visibleTaskProvidersDefaultedForJira =
    parsed.settings?.visibleTaskProvidersDefaultedForJira === true
  const migratedVisibleTaskProviders = visibleTaskProvidersDefaultedForJira
    ? rawTaskProviderSettings.visibleTaskProviders
    : rawTaskProviderSettings.visibleTaskProviders.includes('jira')
      ? rawTaskProviderSettings.visibleTaskProviders
      : [...rawTaskProviderSettings.visibleTaskProviders, 'jira' as const]
  const taskProviderSettings = normalizeTaskProviderSettings({
    visibleTaskProviders: migratedVisibleTaskProviders,
    defaultTaskSource: rawTaskProviderSettings.defaultTaskSource
  })
  const primarySelectionDefaultedForLinux =
    parsed.settings?.primarySelectionMiddleClickPasteDefaultedForLinux === true
  const primarySelectionDefaultedForTerminalDefaults =
    parsed.settings?.primarySelectionMiddleClickPasteDefaultedForTerminalDefaults === true
  const primarySelectionPlatformDefaultEnabled =
    defaults.settings.primarySelectionMiddleClickPaste === true
  const primarySelectionAlreadyDefaultedForPlatform =
    primarySelectionDefaultedForTerminalDefaults ||
    (process.platform === 'linux' && primarySelectionDefaultedForLinux)
  const migratePrimarySelectionPlatformDefault =
    primarySelectionPlatformDefaultEnabled && !primarySelectionAlreadyDefaultedForPlatform
  const stampPrimarySelectionTerminalDefaults =
    primarySelectionPlatformDefaultEnabled && !primarySelectionDefaultedForTerminalDefaults
  if (migratePrimarySelectionPlatformDefault || stampPrimarySelectionTerminalDefaults) {
    markNeedsSave()
  }
  if (!visibleTaskProvidersDefaultedForJira) {
    markNeedsSave()
  }
  const claudeAgentTeamsDefaultDisabledMigrated =
    parsed.settings?.claudeAgentTeamsDefaultDisabledMigrated === true
  if (!claudeAgentTeamsDefaultDisabledMigrated) {
    markNeedsSave()
  }
  const migratedDisabledTuiAgents = normalizeDisabledTuiAgents(parsed.settings?.disabledTuiAgents)
  const migratedAgentYoloDefaults = migrateAgentYoloDefaults(parsed.settings)
  const migratedAgentPermission = migrateAgentPermissionChoice(
    {
      ...migratedAgentYoloDefaults,
      agentPermissionDefault: parsed.settings?.agentPermissionDefault,
      agentPermissionOverrides: parsed.settings?.agentPermissionOverrides
    },
    process.platform
  )
  if (
    parsed.settings?.agentYoloDefaultsMigrated !== true ||
    !hasTypedAgentPermission(parsed.settings) ||
    parsed.settings?.agentDefaultArgs?.devin !==
      migratedAgentYoloDefaults.agentDefaultArgs?.devin ||
    hasUnsupportedTuiAgentArgs('opencode', parsed.settings?.agentDefaultArgs?.opencode) ||
    hasUnsupportedTuiAgentArgs('kilo', parsed.settings?.agentDefaultArgs?.kilo)
  ) {
    markNeedsSave()
  }
  if (
    !claudeAgentTeamsDefaultDisabledMigrated &&
    !migratedDisabledTuiAgents.includes('claude-agent-teams')
  ) {
    migratedDisabledTuiAgents.push('claude-agent-teams')
  }
  const migratedWindowsRuntimeDefault =
    parsed.settings?.localWindowsRuntimeDefault === undefined
      ? deriveGlobalWindowsRuntimeDefaultFromLegacySettings(parsed.settings).defaultRuntime
      : parsed.settings.localWindowsRuntimeDefault
  if (
    parsed.settings?.localWindowsRuntimeDefault === undefined &&
    migratedWindowsRuntimeDefault.kind === 'wsl'
  ) {
    markNeedsSave()
  }
  // Replace the ambiguous legacy host default once so WSL users follow their selected runtime.
  const localAccountRuntimeAlreadyMigrated =
    parsed.settings?.localAccountRuntimeDefaultedToAutoForAllUsers === true
  const migratedLocalAccountRuntime: GlobalSettings['localAccountRuntime'] =
    localAccountRuntimeAlreadyMigrated
      ? (parsed.settings?.localAccountRuntime ?? defaults.settings.localAccountRuntime)
      : parsed.settings?.localAccountRuntime === 'wsl'
        ? 'wsl'
        : 'auto'
  if (!localAccountRuntimeAlreadyMigrated) {
    markNeedsSave()
  }
  if (!autoRenameBranchFromWorkDefaultedOn) {
    markNeedsSave()
  }
  const normalizedOnboarding = normalizeLoadedOnboardingState(
    parsed.onboarding,
    defaults.onboarding
  )
  if (!parsed.onboarding) {
    markNeedsSave()
  }
  const normalizedProjectGroups = normalizeProjectGroups(parsed.projectGroups)
  const loadedCompactWorktreeCards =
    parsed.settings?.compactWorktreeCards ??
    parsed.settings?.experimentalCompactWorktreeCards ??
    defaults.settings.compactWorktreeCards
  const mobilePairingCustomAddress = normalizeMobilePairingCustomAddress(
    parsed.settings?.mobilePairingCustomAddress
  )
  const rawMobilePairingCustomAddresses = parsed.settings?.mobilePairingCustomAddresses
  const mobilePairingCustomAddresses = mobilePairingCustomAddress
    ? addMobilePairingCustomAddress(
        normalizeMobilePairingCustomAddresses(rawMobilePairingCustomAddresses),
        mobilePairingCustomAddress
      )
    : normalizeMobilePairingCustomAddresses(rawMobilePairingCustomAddresses)
  if (
    parsed.settings?.mobilePairingCustomAddress !== undefined &&
    parsed.settings.mobilePairingCustomAddress !== mobilePairingCustomAddress
  ) {
    markNeedsSave()
  }
  const customAddressesMatch =
    Array.isArray(rawMobilePairingCustomAddresses) &&
    rawMobilePairingCustomAddresses.length === mobilePairingCustomAddresses.length &&
    rawMobilePairingCustomAddresses.every(
      (address, index) => address === mobilePairingCustomAddresses[index]
    )
  if (
    (rawMobilePairingCustomAddresses !== undefined || mobilePairingCustomAddress !== null) &&
    !customAddressesMatch
  ) {
    markNeedsSave()
  }
  const normalizedNotifications = normalizeNotificationSettings(parsed.settings?.notifications)
  // Persist repaired notification fields so bad disk values do not recur on launch.
  if (
    persistedNotificationSettingsRepaired(parsed.settings?.notifications, normalizedNotifications)
  ) {
    markNeedsSave()
  }
  const normalizedSourceControlGroupOrder = normalizeSourceControlGroupOrder(
    parsed.settings?.sourceControlGroupOrder
  )
  if (
    parsed.settings?.sourceControlGroupOrder !== undefined &&
    parsed.settings.sourceControlGroupOrder !== normalizedSourceControlGroupOrder
  ) {
    markNeedsSave()
  }
  return {
    migratedPortugueseUiLanguage,
    migratedExperimentalActivity,
    migratedAutoRenameBranchFromWork,
    migratedTerminalCursorStyle,
    migratedTerminalLineHeight,
    terminalRightClickToPasteDefaultedForPlatform,
    taskProviderSettings,
    primarySelectionDefaultedForLinux,
    primarySelectionDefaultedForTerminalDefaults,
    migratePrimarySelectionPlatformDefault,
    stampPrimarySelectionTerminalDefaults,
    migratedDisabledTuiAgents,
    migratedAgentYoloDefaults,
    migratedAgentPermission,
    migratedWindowsRuntimeDefault,
    migratedLocalAccountRuntime,
    loadedCompactWorktreeCards,
    mobilePairingCustomAddress,
    mobilePairingCustomAddresses,
    normalizedNotifications,
    normalizedSourceControlGroupOrder,
    normalizedOnboarding,
    normalizedProjectGroups
  }
}
