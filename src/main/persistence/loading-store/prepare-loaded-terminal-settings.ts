import { migrateActionPermissionArgs } from '../../../shared/source-control-action-permission-lift'
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
  let migratedSourceControlAi = rawSourceControlAiMissing
    ? sourceControlAiSettingsFromLegacy(legacyCommitMessageAi ?? defaults.settings.commitMessageAi)
    : mergeLegacyCommitMessageAiIntoSourceControlAi(
        parsed.settings?.sourceControlAi,
        legacyCommitMessageAi
      )
  const actions = migrateActionPermissionArgs(migratedSourceControlAi.actions)
  if (actions !== migratedSourceControlAi.actions) {
    migratedSourceControlAi = { ...migratedSourceControlAi, actions }
    markNeedsSave()
  }
  migratedExternalVisibility.repos = migratedExternalVisibility.repos.map((repo) => {
    const actionOverrides = migrateActionPermissionArgs(repo.sourceControlAi?.actionOverrides)
    if (actionOverrides === repo.sourceControlAi?.actionOverrides) {
      return repo
    }
    markNeedsSave()
    return { ...repo, sourceControlAi: { ...repo.sourceControlAi, actionOverrides } }
  })
  // Legacy Option-as-Alt true broke non-US characters; let the layout probe choose once.
  const rawOptionAsAlt = parsed.settings?.terminalMacOptionAsAlt
  const alreadyMigrated = parsed.settings?.terminalMacOptionAsAltMigrated === true
  const migratedOptionAsAlt: 'auto' | 'true' | 'false' | 'left' | 'right' = alreadyMigrated
    ? (rawOptionAsAlt ?? 'auto')
    : rawOptionAsAlt === undefined || rawOptionAsAlt === 'true'
      ? 'auto'
      : rawOptionAsAlt
  const floatingTerminalDefaultedForAllUsers =
    parsed.settings?.floatingTerminalDefaultedForAllUsers === true
  // Flip the old persisted off default once; retain later opt-outs.
  const migratedFloatingTerminalEnabled = floatingTerminalDefaultedForAllUsers
    ? (parsed.settings?.floatingTerminalEnabled ?? true)
    : true
  // Legacy off values conflate default and opt-out; migrate only unstamped profiles.
  const migratedOsc52Clipboard = normalizeOsc52ClipboardDefaultOn(parsed.settings)
  const osc52ClipboardNoticePending =
    osc52ClipboardDefaultOnOverridesPersistedOff(parsed.settings) ||
    parsed.ui?.osc52ClipboardDefaultOnNoticePending === true
  if (parsed.settings?.terminalAllowOsc52ClipboardDefaultedOnForAllUsers !== true) {
    markNeedsSave()
  }
  const floatingTerminalCwdMigrated =
    parsed.settings?.floatingTerminalCwdMigratedToAppWorkspace === true
  // Repair the old empty notes-directory migration; terminal cwd and notes now resolve separately.
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
      // An explicitly configured legacy floating cwd establishes prior trust.
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
