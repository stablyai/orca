import { homedir } from 'node:os'
import type { GlobalSettings, OrcaWorkspaceLayout } from '../../../shared/global-settings-types'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import {
  legacyTerminalScrollbackBytesToRows,
  normalizeDesktopTerminalScrollbackRows
} from '../../../shared/terminal-scrollback-policy'
import {
  DEFAULT_TUI_AGENT_ARGS,
  DEFAULT_TUI_AGENT_ENV,
  normalizeTuiAgentArgsRecord,
  normalizeTuiAgentEnvRecord
} from '../../../shared/tui-agent-launch-defaults'
import { expandLeadingHomePath } from '../../home-path-expansion'

/** Unexpanded, a leading ~ resolves inside each repo and worktrees land in <repo>/~ (#34944). */
export function expandWorkspaceDirHome(settings: Partial<GlobalSettings>): Partial<GlobalSettings> {
  return typeof settings.workspaceDir === 'string'
    ? { ...settings, workspaceDir: expandLeadingHomePath(settings.workspaceDir, homedir()) }
    : settings
}

export function buildWorkspaceDirHistoryForUpdate(
  current: GlobalSettings,
  updates: Partial<GlobalSettings>
): OrcaWorkspaceLayout[] | null {
  if (!('workspaceDir' in updates) && !('nestWorkspaces' in updates)) {
    return null
  }
  const nextPath = updates.workspaceDir ?? current.workspaceDir
  const nextNestWorkspaces = updates.nestWorkspaces ?? current.nestWorkspaces
  if (
    normalizeRuntimePathForComparison(nextPath) ===
      normalizeRuntimePathForComparison(current.workspaceDir) &&
    nextNestWorkspaces === current.nestWorkspaces
  ) {
    return null
  }

  const previousLayout = {
    path: current.workspaceDir,
    nestWorkspaces: current.nestWorkspaces
  }
  const existing = current.workspaceDirHistory ?? []
  const next = [...existing]
  const previousKey = getWorkspaceLayoutHistoryKey(previousLayout)
  if (!next.some((layout) => getWorkspaceLayoutHistoryKey(layout) === previousKey)) {
    next.push(previousLayout)
  }
  return next
}

export type LegacyTerminalScrollbackSettings = {
  terminalScrollbackRows?: unknown
  terminalScrollbackBytes?: unknown
}

export const LEGACY_TERMINAL_TUI_SCROLL_SENSITIVITY_DEFAULT = 3

export function readLegacyTerminalScrollbackSettings(
  settings: unknown
): LegacyTerminalScrollbackSettings {
  return settings && typeof settings === 'object'
    ? (settings as LegacyTerminalScrollbackSettings)
    : {}
}

type RetiredGlobalSettings = {
  agentNativeChatPermissionModes?: unknown
  setupScriptLaunchMode?: unknown
  terminalScrollbackBytes?: unknown
  enableGitHubAttribution?: unknown
  showAgentsSidebar?: unknown
  // Older builds interpret an absent managed-server switch as off.
  experimentalManagedServers?: unknown
  // Remove legacy settings secrets now owned by the main-process credential store.
  opencodeGoApiKey?: unknown
  experimentalStructuredNativeChat?: unknown
  openAgentTabsInChatByDefault?: unknown
  // Full-access plugins now need only their own approval.
  pluginFullAccessEnabled?: unknown
}

export function stripRetiredGlobalSettings(
  settings: Partial<GlobalSettings> | undefined
): Partial<GlobalSettings> {
  const {
    agentNativeChatPermissionModes: _retiredChatPermissionCopies,
    setupScriptLaunchMode: _legacySetupScriptLaunchMode,
    terminalScrollbackBytes: _legacyScrollbackBytes,
    enableGitHubAttribution: _legacyGitHubAttribution,
    showAgentsSidebar: _legacyShowAgentsSidebar,
    experimentalManagedServers: _retiredManagedServersExperiment,
    opencodeGoApiKey: _legacyOpenCodeGoApiKey,
    experimentalStructuredNativeChat: _legacyStructuredNativeChat,
    openAgentTabsInChatByDefault: _legacyChatDefaultView,
    pluginFullAccessEnabled: _retiredPluginFullAccessSwitch,
    ...rest
  } = (settings ?? {}) as Partial<GlobalSettings> & RetiredGlobalSettings
  void _retiredChatPermissionCopies
  void _legacySetupScriptLaunchMode
  void _legacyScrollbackBytes
  void _legacyGitHubAttribution
  void _legacyShowAgentsSidebar
  void _retiredManagedServersExperiment
  void _legacyOpenCodeGoApiKey
  void _legacyStructuredNativeChat
  void _legacyChatDefaultView
  void _retiredPluginFullAccessSwitch
  return rest
}

/** Preserve terminal-first behavior for pre-retirement profiles whose Chat UI was enabled. */
export function savedChatUiWithTerminalDefaultView(settings: unknown): boolean {
  return (
    typeof settings === 'object' &&
    settings !== null &&
    'experimentalNativeChat' in settings &&
    settings.experimentalNativeChat === true &&
    'openAgentTabsInChatByDefault' in settings &&
    settings.openAgentTabsInChatByDefault !== true
  )
}

export function migrateTerminalScrollbackRows(settings: unknown): {
  rows: number
  needsSave: boolean
} {
  const legacySettings = readLegacyTerminalScrollbackSettings(settings)
  const hasRows = Object.hasOwn(legacySettings, 'terminalScrollbackRows')
  const hasLegacyBytes = Object.hasOwn(legacySettings, 'terminalScrollbackBytes')
  const rows = hasRows
    ? normalizeDesktopTerminalScrollbackRows(legacySettings.terminalScrollbackRows)
    : legacyTerminalScrollbackBytesToRows(legacySettings.terminalScrollbackBytes)

  return {
    rows,
    needsSave: !hasRows || hasLegacyBytes || legacySettings.terminalScrollbackRows !== rows
  }
}

export function migrateTerminalTuiScrollSensitivityDefault(settings: GlobalSettings | undefined): {
  settings: Pick<
    GlobalSettings,
    'terminalTuiScrollSensitivity' | 'terminalTuiScrollSensitivityDefaultedToOne'
  >
  needsSave: boolean
} {
  const alreadyDefaultedToOne = settings?.terminalTuiScrollSensitivityDefaultedToOne === true
  const current = settings?.terminalTuiScrollSensitivity
  const shouldMoveInheritedDefault =
    !alreadyDefaultedToOne &&
    (current === undefined || current === LEGACY_TERMINAL_TUI_SCROLL_SENSITIVITY_DEFAULT)
  const terminalTuiScrollSensitivity = shouldMoveInheritedDefault ? 1 : (current ?? 1)

  return {
    settings: {
      terminalTuiScrollSensitivity,
      terminalTuiScrollSensitivityDefaultedToOne: true
    },
    needsSave: !alreadyDefaultedToOne || current === undefined
  }
}

export function getWorkspaceLayoutHistoryKey(layout: OrcaWorkspaceLayout): string {
  return `${normalizeRuntimePathForComparison(layout.path)}:${layout.nestWorkspaces}`
}

export function migrateAgentYoloDefaults(
  settings: GlobalSettings | undefined
): Pick<GlobalSettings, 'agentDefaultArgs' | 'agentDefaultEnv' | 'agentYoloDefaultsMigrated'> {
  const existingArgs = normalizeTuiAgentArgsRecord(settings?.agentDefaultArgs)
  const existingEnv = normalizeTuiAgentEnvRecord(settings?.agentDefaultEnv)
  if (existingArgs.devin === '--permission-mode bypass') {
    existingArgs.devin = DEFAULT_TUI_AGENT_ARGS.devin
  }
  if (settings?.agentYoloDefaultsMigrated === true) {
    // Pin newly added agents to manual; missing keys otherwise inherit current yolo defaults.
    for (const agent of Object.keys(DEFAULT_TUI_AGENT_ARGS)) {
      if (!(agent in existingArgs)) {
        existingArgs[agent as keyof typeof DEFAULT_TUI_AGENT_ARGS] = ''
      }
    }
    for (const agent of Object.keys(DEFAULT_TUI_AGENT_ENV)) {
      if (!(agent in existingEnv)) {
        existingEnv[agent as keyof typeof DEFAULT_TUI_AGENT_ENV] = {}
      }
    }
    return {
      agentDefaultArgs: existingArgs,
      agentDefaultEnv: existingEnv,
      agentYoloDefaultsMigrated: true
    }
  }

  const commandOverrides = settings?.agentCmdOverrides ?? {}
  const migratedArgs = { ...existingArgs }
  for (const [agent, args] of Object.entries(DEFAULT_TUI_AGENT_ARGS)) {
    if (agent in migratedArgs) {
      continue
    }
    if (agent in commandOverrides) {
      migratedArgs[agent as keyof typeof DEFAULT_TUI_AGENT_ARGS] = ''
      continue
    }
    migratedArgs[agent as keyof typeof DEFAULT_TUI_AGENT_ARGS] = args
  }

  const migratedEnv = { ...existingEnv }
  for (const [agent, env] of Object.entries(DEFAULT_TUI_AGENT_ENV)) {
    if (agent in migratedEnv) {
      continue
    }
    if (agent in commandOverrides) {
      migratedEnv[agent as keyof typeof DEFAULT_TUI_AGENT_ENV] = {}
      continue
    }
    migratedEnv[agent as keyof typeof DEFAULT_TUI_AGENT_ENV] = { ...env }
  }

  return {
    // Legacy command overrides establish user ownership of launch defaults.
    agentDefaultArgs: migratedArgs,
    agentDefaultEnv: migratedEnv,
    agentYoloDefaultsMigrated: true
  }
}
