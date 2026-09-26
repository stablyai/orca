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
import { resolveConfiguredAgentPermissionModeSummary } from '../../../shared/tui-agent-permissions'

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
}

export function stripRetiredGlobalSettings(
  settings: Partial<GlobalSettings> | undefined
): Partial<GlobalSettings> {
  const {
    terminalScrollbackBytes: _legacyScrollbackBytes,
    enableGitHubAttribution: _legacyGitHubAttribution,
    showAgentsSidebar: _legacyShowAgentsSidebar,
    ...rest
  } = (settings ?? {}) as Partial<GlobalSettings> & RetiredGlobalSettings
  void _legacyScrollbackBytes
  void _legacyGitHubAttribution
  void _legacyShowAgentsSidebar
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

const REGRESSION_BACKFILLED_AGENTS: readonly (keyof typeof DEFAULT_TUI_AGENT_ARGS)[] = [
  'ante',
  'devin',
  'trae',
  'droid',
  'muse',
  'zcode'
]

/**
 * Migrates agent default launch arguments and environment variables to match the active permission posture.
 *
 * For profiles migrated prior to agent additions, inherits the profile's active permission mode
 * ('yolo', 'manual', or 'mixed') for newly added agents. Also executes a one-time repair for agents
 * backfilled to manual by PR #17515 on profiles that were actively configured in YOLO mode.
 *
 * @param settings - The global settings object being loaded or updated.
 * @returns The migrated agent default arguments, environment variables, and migration guard flags.
 */
export function migrateAgentYoloDefaults(
  settings: GlobalSettings | undefined
): Pick<
  GlobalSettings,
  | 'agentDefaultArgs'
  | 'agentDefaultEnv'
  | 'agentYoloDefaultsMigrated'
  | 'agentYoloDefaultsBackfillRepaired'
> {
  const existingArgs = normalizeTuiAgentArgsRecord(settings?.agentDefaultArgs)
  const existingEnv = normalizeTuiAgentEnvRecord(settings?.agentDefaultEnv)
  if (existingArgs.devin === '--permission-mode bypass') {
    existingArgs.devin = DEFAULT_TUI_AGENT_ARGS.devin
  }
  if (settings?.agentYoloDefaultsMigrated === true) {
    // Inherit the profile's active permission mode for newly added agents instead of forcing manual.
    // Also repair agents that were backfilled to manual by PR #17515 if the profile's active posture is yolo.
    const alreadyRepaired = settings?.agentYoloDefaultsBackfillRepaired === true
    const backfilledArgsAgents = alreadyRepaired
      ? []
      : REGRESSION_BACKFILLED_AGENTS.filter((agent) => existingArgs[agent] === '')
    const backfilledEnvGoose =
      !alreadyRepaired &&
      existingEnv.goose !== undefined &&
      Object.keys(existingEnv.goose).length === 0

    const isOtherwiseYolo =
      !alreadyRepaired &&
      resolveConfiguredAgentPermissionModeSummary({
        agentDefaultArgs: existingArgs,
        agentDefaultEnv: existingEnv,
        excludeAgents: [
          ...backfilledArgsAgents,
          ...(backfilledEnvGoose ? (['goose'] as const) : [])
        ]
      }) === 'yolo'

    if (isOtherwiseYolo) {
      for (const agent of backfilledArgsAgents) {
        existingArgs[agent] = DEFAULT_TUI_AGENT_ARGS[agent]
      }
      if (backfilledEnvGoose) {
        existingEnv.goose = { ...DEFAULT_TUI_AGENT_ENV.goose }
      }
    }

    const permissionMode = isOtherwiseYolo
      ? 'yolo'
      : resolveConfiguredAgentPermissionModeSummary({
          agentDefaultArgs: existingArgs,
          agentDefaultEnv: existingEnv
        })

    const commandOverrides = settings?.agentCmdOverrides ?? {}
    for (const [agent, args] of Object.entries(DEFAULT_TUI_AGENT_ARGS)) {
      if (!(agent in existingArgs)) {
        existingArgs[agent as keyof typeof DEFAULT_TUI_AGENT_ARGS] =
          agent in commandOverrides ? '' : permissionMode === 'yolo' ? args : ''
      }
    }
    for (const [agent, env] of Object.entries(DEFAULT_TUI_AGENT_ENV)) {
      if (!(agent in existingEnv)) {
        existingEnv[agent as keyof typeof DEFAULT_TUI_AGENT_ENV] =
          agent in commandOverrides ? {} : permissionMode === 'yolo' ? { ...env } : {}
      }
    }
    return {
      agentDefaultArgs: existingArgs,
      agentDefaultEnv: existingEnv,
      agentYoloDefaultsMigrated: true,
      agentYoloDefaultsBackfillRepaired: true
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
    // Why: legacy users could only customize launch defaults via command overrides, so those agents count as already user-owned.
    agentDefaultArgs: migratedArgs,
    agentDefaultEnv: migratedEnv,
    agentYoloDefaultsMigrated: true,
    agentYoloDefaultsBackfillRepaired: true
  }
}
