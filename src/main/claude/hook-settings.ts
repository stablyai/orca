import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  hookDefinitionHasManagedCommand,
  readHooksJson,
  removeManagedCommands,
  wrapPosixHookCommand,
  wrapWindowsHookCommand,
  type HookDefinition,
  type HooksConfig
} from '../agent-hooks/installer-utils'

export type ClaudeCompatibleHookSettings = {
  configDirName: '.claude' | '.openclaude'
  scriptBaseName: 'claude-hook' | 'openclaude-hook'
}

export const CLAUDE_HOOK_SETTINGS: ClaudeCompatibleHookSettings = {
  configDirName: '.claude',
  scriptBaseName: 'claude-hook'
}

export const OPENCLAUDE_HOOK_SETTINGS: ClaudeCompatibleHookSettings = {
  configDirName: '.openclaude',
  scriptBaseName: 'openclaude-hook'
}

export const CLAUDE_EVENTS = [
  { eventName: 'UserPromptSubmit', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'Stop', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'StopFailure', definition: { hooks: [{ type: 'command', command: '' }] } },
  {
    eventName: 'PreToolUse',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PostToolUse',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PostToolUseFailure',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PermissionRequest',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  }
] as const

/**
 * Primary config path for managed hooks. Uses settings.local.json (machine-specific
 * overrides) so hooks are not synced across machines when users git-manage their
 * .claude directory with a whitelist .gitignore. Claude Code treats settings.local.json
 * as the machine-specific override file that should NOT be committed to version control.
 */
export function getLocalConfigPath(settings = CLAUDE_HOOK_SETTINGS): string {
  return join(homedir(), settings.configDirName, 'settings.local.json')
}

/**
 * Legacy config path. Some existing installations may have hooks in settings.json
 * (the shared/project file). We read from this for backward compat but write to
 * settings.local.json for new installs.
 */
export function getLegacyConfigPath(settings = CLAUDE_HOOK_SETTINGS): string {
  return join(homedir(), settings.configDirName, 'settings.json')
}

/**
 * Returns both config paths that Orca checks for managed hooks.
 * Order: primary (local) first, then legacy.
 */
export function getConfigPaths(settings = CLAUDE_HOOK_SETTINGS): string[] {
  return [getLocalConfigPath(settings), getLegacyConfigPath(settings)]
}

export function getManagedScriptFileName(settings = CLAUDE_HOOK_SETTINGS): string {
  return process.platform === 'win32'
    ? `${settings.scriptBaseName}.cmd`
    : getPosixManagedScriptFileName(settings)
}

export function getPosixManagedScriptFileName(settings = CLAUDE_HOOK_SETTINGS): string {
  return `${settings.scriptBaseName}.sh`
}

export function getManagedScriptPath(settings = CLAUDE_HOOK_SETTINGS): string {
  return getSharedManagedScriptPath(getManagedScriptFileName(settings))
}

/**
 * Remote config path now uses settings.local.json for the same reason as local:
 * machine-specific hooks should not be synced across machines.
 */
export function getRemoteConfigPath(remoteHome: string, settings = CLAUDE_HOOK_SETTINGS): string {
  return `${remoteHome.replace(/\/$/, '')}/${settings.configDirName}/settings.local.json`
}

export function getManagedCommand(scriptPath: string): string {
  if (process.platform === 'win32') {
    return wrapWindowsHookCommand(scriptPath)
  }
  return wrapPosixHookCommand(scriptPath)
}

export function getRemoteManagedCommand(scriptPath: string): string {
  return wrapPosixHookCommand(scriptPath)
}

/**
 * Find which config file currently contains managed hooks for this agent.
 * Returns the path and config object, or undefined if hooks are not installed.
 * Checks settings.local.json first (primary), then settings.json (legacy).
 */
export function findManagedConfigPath(
  settings = CLAUDE_HOOK_SETTINGS,
  scriptFileName = getManagedScriptFileName(settings)
): { configPath: string; config: HooksConfig } | undefined {
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  for (const configPath of getConfigPaths(settings)) {
    const config = readHooksJson(configPath)
    if (!config) continue
    for (const event of CLAUDE_EVENTS) {
      const definitions = Array.isArray(config.hooks?.[event.eventName])
        ? config.hooks![event.eventName]!
        : []
      if (definitions.some(def => hookDefinitionHasManagedCommand(def, isManagedCommand))) {
        return { configPath, config }
      }
    }
  }
  return undefined
}

/**
 * Read hooks config from whichever file has managed hooks, with fallback to
 * settings.local.json for new installs.
 */
export function readHooksJsonWithFallback(
  settings = CLAUDE_HOOK_SETTINGS,
  scriptFileName = getManagedScriptFileName(settings)
): { configPath: string; config: HooksConfig } {
  const existing = findManagedConfigPath(settings, scriptFileName)
  if (existing) return existing
  const configPath = getLocalConfigPath(settings)
  const config = readHooksJson(configPath) ?? {}
  return { configPath, config }
}

export function applyManagedHooks(
  config: HooksConfig,
  command: string,
  scriptFileName = getManagedScriptFileName()
): HooksConfig {
  const nextHooks = { ...config.hooks }
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)

  for (const event of CLAUDE_EVENTS) {
    const current = Array.isArray(nextHooks[event.eventName]) ? nextHooks[event.eventName] : []
    const cleaned = removeManagedCommands(current, isManagedCommand)
    const definition: HookDefinition = {
      ...event.definition,
      hooks: [buildManagedCommandHook(command)]
    }
    nextHooks[event.eventName] = [...cleaned, definition]
  }

  return { ...config, hooks: nextHooks }
}

export function removeManagedHooks(
  config: HooksConfig,
  scriptFileName = getManagedScriptFileName()
): {
  config: HooksConfig
  changed: boolean
} {
  const nextHooks = { ...config.hooks }
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  let changed = false

  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (JSON.stringify(cleaned) !== JSON.stringify(definitions)) {
      changed = true
    }
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }

  return {
    config: { ...config, hooks: nextHooks },
    changed
  }
}
