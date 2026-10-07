import type { GlobalSettings, OrcaWorkspaceLayout } from '../../../shared/global-settings-types'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import {
  legacyTerminalScrollbackBytesToRows,
  normalizeDesktopTerminalScrollbackRows
} from '../../../shared/terminal-scrollback-policy'
import {
  normalizeTuiAgentArgsRecord,
  normalizeTuiAgentEnvRecord
} from '../../../shared/tui-agent-launch-defaults'
import {
  PERMISSION_AGENT_IDS,
  YOLO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ENV
} from '../../../shared/tui-agent-permissions'
import type { TuiAgent } from '../../../shared/tui-agent'
import { resolveLocalAgentLaunchTarget } from '../../../shared/windows-terminal-shell'
import {
  liftAgentBypassFromTypedProfile,
  liftComposedAgentLaunchProfile
} from '../../../shared/agent-launch-profile-lift'

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
  terminalScrollbackBytes?: unknown
  enableGitHubAttribution?: unknown
  showAgentsSidebar?: unknown
  // Why: #22551 kept this key in settings; it now lives in a main-owned store and must never ride along.
  opencodeGoApiKey?: unknown
}

export function stripRetiredGlobalSettings(
  settings: Partial<GlobalSettings> | undefined
): Partial<GlobalSettings> {
  const {
    terminalScrollbackBytes: _legacyScrollbackBytes,
    enableGitHubAttribution: _legacyGitHubAttribution,
    showAgentsSidebar: _legacyShowAgentsSidebar,
    opencodeGoApiKey: _legacyOpenCodeGoApiKey,
    ...rest
  } = (settings ?? {}) as Partial<GlobalSettings> & RetiredGlobalSettings
  void _legacyScrollbackBytes
  void _legacyGitHubAttribution
  void _legacyShowAgentsSidebar
  void _legacyOpenCodeGoApiKey
  return rest
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

/** The launch arguments a profile saved before the permission mode was typed would have run with. */
function migrateAgentYoloDefaults(
  settings: GlobalSettings | undefined
): Pick<GlobalSettings, 'agentDefaultArgs' | 'agentDefaultEnv' | 'agentYoloDefaultsMigrated'> {
  const existingArgs = normalizeTuiAgentArgsRecord(settings?.agentDefaultArgs)
  const existingEnv = normalizeTuiAgentEnvRecord(settings?.agentDefaultEnv)
  // An older build's Devin default; main moved it to the current flag when it loaded (#21925).
  if (existingArgs.devin === '--permission-mode bypass') {
    existingArgs.devin = YOLO_TUI_AGENT_ARGS.devin
  }
  // Agents missing from an older build's profile stay manual; command-override users owned theirs.
  const commandOverrides = settings?.agentCmdOverrides ?? {}
  const keepManual = (agent: TuiAgent): boolean =>
    settings?.agentYoloDefaultsMigrated === true || agent in commandOverrides
  const migratedArgs = { ...existingArgs }
  const migratedEnv = { ...existingEnv }
  for (const agent of PERMISSION_AGENT_IDS) {
    const bypassArgs = YOLO_TUI_AGENT_ARGS[agent]
    if (bypassArgs !== undefined && !(agent in migratedArgs)) {
      migratedArgs[agent] = keepManual(agent) ? '' : bypassArgs
    }
    const bypassEnv = YOLO_TUI_AGENT_ENV[agent]
    if (bypassEnv !== undefined && !(agent in migratedEnv)) {
      migratedEnv[agent] = keepManual(agent) ? {} : { ...bypassEnv }
    }
  }

  return {
    agentDefaultArgs: migratedArgs,
    agentDefaultEnv: migratedEnv,
    agentYoloDefaultsMigrated: true
  }
}

export type MigratedAgentLaunchProfile = Pick<
  GlobalSettings,
  | 'agentDefaultArgs'
  | 'agentDefaultEnv'
  | 'agentYoloDefaultsMigrated'
  | 'agentPermissionMode'
  | 'agentPermissionModeOverrides'
>

/**
 * Loads the agent launch profile as a typed mode plus extra text. Any stored mode means already
 * migrated (one a newer build wrote is kept as is); older profiles get the yolo-defaults pass
 * first, then the flag lifted into the mode.
 */
export function migrateAgentLaunchProfile(settings: GlobalSettings | undefined): {
  profile: MigratedAgentLaunchProfile
  migrated: boolean
} {
  if (settings && settings.agentPermissionMode !== undefined) {
    const { profile, changed } = liftAgentBypassFromTypedProfile(settings)
    return {
      profile: {
        ...profile,
        agentYoloDefaultsMigrated: true,
        agentPermissionMode: settings.agentPermissionMode
      },
      migrated: changed
    }
  }
  return {
    profile: {
      ...liftComposedAgentLaunchProfile(
        migrateAgentYoloDefaults(settings),
        resolveLocalAgentLaunchTarget(process.platform, settings?.terminalWindowsShell)
      ),
      agentYoloDefaultsMigrated: true
    },
    migrated: true
  }
}
