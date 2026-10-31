import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  hookDefinitionHasManagedCommand,
  isPlainObject,
  removeManagedCommands,
  wrapPosixHookCommand,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import { wrapWindowsBatchHookCommand } from '../agent-hooks/windows-direct-cmd-hook-command'

const ZCODE_SCRIPT_BASE = 'zcode-hook'

/** Match ZCode lifecycle events. Omitted matchers mean all tools; Claude-style * is not valid ZCode syntax. */
export const ZCODE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop'
] as const

/** User-edited hooks.events values stay unknown until narrowed at use, never assumed well-formed. */
export type ZCodeHooksRuntimeConfig = {
  enabled?: boolean
  events?: Record<string, unknown>
  [key: string]: unknown
}

export type ZCodeConfig = {
  hooks?: ZCodeHooksRuntimeConfig
  [key: string]: unknown
}

export function getZCodeConfigPath(): string {
  // ZCode resolves ~/.zcode/cli from homedir on every platform, without APPDATA/XDG branching.
  return join(homedir(), '.zcode', 'cli', 'config.json')
}

export function getZCodeRemoteConfigPath(remoteHome: string): string {
  return `${remoteHome.replace(/\/$/, '')}/.zcode/cli/config.json`
}

export function getZCodeManagedScriptFileName(): string {
  return process.platform === 'win32' ? `${ZCODE_SCRIPT_BASE}.cmd` : `${ZCODE_SCRIPT_BASE}.sh`
}

export function getZCodePosixManagedScriptFileName(): string {
  return `${ZCODE_SCRIPT_BASE}.sh`
}

export function getZCodeManagedScriptPath(): string {
  return getSharedManagedScriptPath(getZCodeManagedScriptFileName())
}

export function getZCodeManagedCommand(scriptPath: string): string {
  if (process.platform === 'win32') {
    return wrapWindowsBatchHookCommand(scriptPath)
  }
  return wrapPosixHookCommand(scriptPath)
}

export function getZCodeRemoteManagedCommand(scriptPath: string): string {
  return wrapPosixHookCommand(scriptPath)
}

function getZCodeManagedCommandMatcher(
  scriptFileName = getZCodeManagedScriptFileName()
): (command: string | undefined) => boolean {
  return createManagedCommandMatcher(scriptFileName)
}

export function readZCodeEventMap(config: ZCodeConfig): Record<string, unknown> {
  const events = config.hooks?.events
  return isPlainObject(events) ? events : {}
}

function readEventDefinitions(
  events: Record<string, unknown>,
  eventName: string
): HookDefinition[] {
  const definitions = events[eventName]
  if (!Array.isArray(definitions)) {
    return []
  }
  // Filter malformed user scalars/nulls once so hook consumers cannot throw.
  return definitions.filter((definition): definition is HookDefinition => isPlainObject(definition))
}

export function applyZCodeManagedHooks(
  config: ZCodeConfig,
  command: string,
  scriptFileName = getZCodeManagedScriptFileName()
): ZCodeConfig {
  const nextEvents = { ...readZCodeEventMap(config) }
  const isManagedCommand = getZCodeManagedCommandMatcher(scriptFileName)

  for (const eventName of ZCODE_HOOK_EVENTS) {
    const current = readEventDefinitions(nextEvents, eventName)
    const cleaned = removeManagedCommands(current, isManagedCommand)
    nextEvents[eventName] = [...cleaned, { hooks: [buildManagedCommandHook(command)] }]
  }

  return {
    ...config,
    hooks: {
      ...config.hooks,
      // Events do not run under ZCode's default disabled flag; installation must enable hooks.
      enabled: true,
      events: nextEvents
    }
  }
}

export function removeZCodeManagedHooks(
  config: ZCodeConfig,
  scriptFileName = getZCodeManagedScriptFileName()
): { config: ZCodeConfig; changed: boolean } {
  const events = readZCodeEventMap(config)
  const nextEvents = { ...events }
  const isManagedCommand = getZCodeManagedCommandMatcher(scriptFileName)
  let changed = false

  for (const [eventName, value] of Object.entries(nextEvents)) {
    // Preserve malformed/non-array values Orca never owned.
    if (!Array.isArray(value)) {
      continue
    }
    const definitions = readEventDefinitions(nextEvents, eventName)
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    // Only change owned events; otherwise removing managed hooks also deletes unrelated user-empty entries.
    if (JSON.stringify(cleaned) === JSON.stringify(definitions)) {
      continue
    }
    changed = true
    if (cleaned.length === 0) {
      delete nextEvents[eventName]
    } else {
      nextEvents[eventName] = cleaned
    }
  }

  if (!changed) {
    return { config, changed: false }
  }
  // Do not disable hook runtime on removal; user hooks still need it.
  return { config: { ...config, hooks: { ...config.hooks, events: nextEvents } }, changed: true }
}

export function readManagedZCodeHookEvents(
  config: ZCodeConfig,
  scriptFileName = getZCodeManagedScriptFileName()
): Set<string> {
  const isManagedCommand = getZCodeManagedCommandMatcher(scriptFileName)
  const events = readZCodeEventMap(config)
  return new Set(
    ZCODE_HOOK_EVENTS.filter((eventName) =>
      readEventDefinitions(events, eventName).some((definition) =>
        hookDefinitionHasManagedCommand(definition, isManagedCommand)
      )
    )
  )
}

export function isZCodeHooksEnabled(config: ZCodeConfig): boolean {
  return config.hooks?.enabled === true
}
