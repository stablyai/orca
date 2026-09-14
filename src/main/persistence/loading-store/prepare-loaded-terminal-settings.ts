import { homedir } from 'node:os'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type {
  GlobalSettings,
  WorktreeVisibilityDefaults
} from '../../../shared/global-settings-types'
import type { Repo } from '../../../shared/repo-types'
import { getDefaultPersistedState } from '../../../shared/constants'
import { migrateExternalWorktreeVisibilityDefaults } from '../../../shared/external-worktree-visibility'
import {
  mergeLegacyCommitMessageAiIntoSourceControlAi,
  sourceControlAiSettingsFromLegacy
} from '../../../shared/source-control-ai'
import {
  normalizeOsc52ClipboardDefaultOn,
  osc52ClipboardDefaultOnOverridesPersistedOff
} from '../../../shared/osc52-clipboard-settings'
import {
  migrateTerminalScrollbackRows,
  migrateTerminalTuiScrollSensitivityDefault
} from '../applying-settings/terminal-settings-migrations'
import {
  canonicalizePersistedFloatingWorkspaceDirectory,
  normalizeFloatingWorkspaceTrustedCwds
} from '../restoring-sessions/floating-workspace-normalization'

export type PreparedLoadedTerminalSettings = {
  defaults: PersistedState
  migratedExternalVisibility: {
    repos: Repo[]
    defaults: WorktreeVisibilityDefaults
    changed: boolean
  }
  migratedTerminalScrollback: { rows: number; needsSave: boolean }
  migratedTerminalTuiScrollSensitivity: {
    settings: Pick<
      GlobalSettings,
      'terminalTuiScrollSensitivity' | 'terminalTuiScrollSensitivityDefaultedToOne'
    >
    needsSave: boolean
  }
  migratedSourceControlAi: NonNullable<GlobalSettings['sourceControlAi']>
  migratedOptionAsAlt: GlobalSettings['terminalMacOptionAsAlt']
  migratedFloatingTerminalEnabled: GlobalSettings['floatingTerminalEnabled']
  migratedOsc52Clipboard: Pick<
    GlobalSettings,
    'terminalAllowOsc52Clipboard' | 'terminalAllowOsc52ClipboardDefaultedOnForAllUsers'
  >
  migratedFloatingTerminalCwd: GlobalSettings['floatingTerminalCwd']
  migratedFloatingTerminalTrustedCwds: GlobalSettings['floatingTerminalTrustedCwds']
  osc52ClipboardNoticePending: boolean
}

export function prepareLoadedTerminalSettings(
  parsed: PersistedState,
  markNeedsSave: () => void
): PreparedLoadedTerminalSettings {
  // Merge with defaults in case new fields were added
  const homeDir = homedir()
  const defaults = getDefaultPersistedState(homeDir)
  const migratedExternalVisibility = migrateExternalWorktreeVisibilityDefaults(
    Array.isArray(parsed.repos) ? parsed.repos : [],
    parsed.settings?.worktreeVisibilityDefaults
  )
  if (migratedExternalVisibility.changed) {
    markNeedsSave()
  }
  const migratedTerminalScrollback = migrateTerminalScrollbackRows(parsed.settings)
  if (migratedTerminalScrollback.needsSave) {
    markNeedsSave()
  }
  if (
    parsed.settings &&
    typeof parsed.settings === 'object' &&
    Object.hasOwn(parsed.settings, 'enableGitHubAttribution')
  ) {
    markNeedsSave()
  }
  const migratedTerminalTuiScrollSensitivity = migrateTerminalTuiScrollSensitivityDefault(
    parsed.settings
  )
  if (migratedTerminalTuiScrollSensitivity.needsSave) {
    markNeedsSave()
  }
  const rawSourceControlAi = parsed.settings?.sourceControlAi
  const rawSourceControlAiMissing = rawSourceControlAi === undefined
  const rawSourceControlAiActionsMissing =
    rawSourceControlAi !== undefined && rawSourceControlAi.actions === undefined
  if (rawSourceControlAiMissing || rawSourceControlAiActionsMissing) {
    markNeedsSave()
  }
  const legacyCommitMessageAi = parsed.settings?.commitMessageAi
  const migratedSourceControlAi = rawSourceControlAiMissing
    ? sourceControlAiSettingsFromLegacy(legacyCommitMessageAi ?? defaults.settings.commitMessageAi)
    : mergeLegacyCommitMessageAiIntoSourceControlAi(
        parsed.settings?.sourceControlAi,
        legacyCommitMessageAi
      )
  // Why (issue #903): old 'true' default broke non-US Option-layer chars; flip 'true'→'auto' once so the layout probe decides.
  const rawOptionAsAlt = parsed.settings?.terminalMacOptionAsAlt
  const alreadyMigrated = parsed.settings?.terminalMacOptionAsAltMigrated === true
  const migratedOptionAsAlt: 'auto' | 'true' | 'false' | 'left' | 'right' = alreadyMigrated
    ? (rawOptionAsAlt ?? 'auto')
    : rawOptionAsAlt === undefined || rawOptionAsAlt === 'true'
      ? 'auto'
      : rawOptionAsAlt
  const floatingTerminalDefaultedForAllUsers =
    parsed.settings?.floatingTerminalDefaultedForAllUsers === true
  // Why: early builds persisted the old off default; flip only unmigrated profiles so a later opt-out survives reload.
  const migratedFloatingTerminalEnabled = floatingTerminalDefaultedForAllUsers
    ? (parsed.settings?.floatingTerminalEnabled ?? true)
    : true
  // Why: the old off default persisted `false` for every profile, indistinguishable from a real opt-out — flip unmigrated profiles once (#10567).
  const migratedOsc52Clipboard = normalizeOsc52ClipboardDefaultOn(parsed.settings)
  const osc52ClipboardNoticePending =
    osc52ClipboardDefaultOnOverridesPersistedOff(parsed.settings) ||
    parsed.ui?.osc52ClipboardDefaultOnNoticePending === true
  if (parsed.settings?.terminalAllowOsc52ClipboardDefaultedOnForAllUsers !== true) {
    markNeedsSave()
  }
  const floatingTerminalCwdMigrated =
    parsed.settings?.floatingTerminalCwdMigratedToAppWorkspace === true
  // Why: an earlier migration wrote '' for the notes dir; floating terminals still open at home, notes use a separate IPC.
  const migratedFloatingTerminalCwd = floatingTerminalCwdMigrated
    ? !parsed.settings?.floatingTerminalCwd
      ? defaults.settings.floatingTerminalCwd
      : parsed.settings.floatingTerminalCwd
    : parsed.settings?.floatingTerminalCwd === undefined
      ? defaults.settings.floatingTerminalCwd
      : parsed.settings.floatingTerminalCwd
  const normalizedFloatingTerminalTrustedCwds = normalizeFloatingWorkspaceTrustedCwds(
    parsed.settings?.floatingTerminalTrustedCwds,
    homeDir
  )
  const migratedFloatingTerminalTrustedCwds = [...normalizedFloatingTerminalTrustedCwds.trustedCwds]
  const rawLegacyFloatingTerminalCwd = parsed.settings?.floatingTerminalCwd
  const shouldTrustLegacyFloatingTerminalCwd =
    !floatingTerminalCwdMigrated &&
    typeof rawLegacyFloatingTerminalCwd === 'string' &&
    rawLegacyFloatingTerminalCwd.trim().length > 0 &&
    rawLegacyFloatingTerminalCwd.trim() !== '~'
  if (!floatingTerminalCwdMigrated) {
    markNeedsSave()
  }
  if (shouldTrustLegacyFloatingTerminalCwd && rawLegacyFloatingTerminalCwd) {
    const canonicalLegacyCwd = canonicalizePersistedFloatingWorkspaceDirectory(
      rawLegacyFloatingTerminalCwd,
      homeDir
    )
    if (canonicalLegacyCwd && !migratedFloatingTerminalTrustedCwds.includes(canonicalLegacyCwd)) {
      // Why: pre-grant profiles with an explicit Floating Workspace cwd already showed intent; migrate only that legacy value.
      migratedFloatingTerminalTrustedCwds.push(canonicalLegacyCwd)
      normalizedFloatingTerminalTrustedCwds.changed = true
    }
  }
  if (normalizedFloatingTerminalTrustedCwds.changed) {
    markNeedsSave()
  }
  return {
    defaults,
    migratedExternalVisibility,
    migratedTerminalScrollback,
    migratedTerminalTuiScrollSensitivity,
    migratedSourceControlAi,
    migratedOptionAsAlt,
    migratedFloatingTerminalEnabled,
    migratedOsc52Clipboard,
    migratedFloatingTerminalCwd,
    migratedFloatingTerminalTrustedCwds,
    osc52ClipboardNoticePending
  }
}
