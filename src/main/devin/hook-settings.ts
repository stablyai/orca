import { homedir } from 'os'
import { join } from 'path'
import {
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  removeManagedCommands,
  wrapPosixHookCommand,
  type HookDefinition,
  type HooksConfig
} from '../agent-hooks/installer-utils'

const DEVIN_SCRIPT_BASE = 'devin-hook'

export const DEVIN_EVENTS = [
  { eventName: 'SessionStart', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'UserPromptSubmit', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'Stop', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'PostCompaction', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'SessionEnd', definition: { hooks: [{ type: 'command', command: '' }] } },
  // Why: Devin treats matchers as regexes and says omitted means "all";
  // Claude's "*" matcher is not a valid Devin regex.
  { eventName: 'PreToolUse', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'PostToolUse', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'PermissionRequest', definition: { hooks: [{ type: 'command', command: '' }] } }
] as const

export function getDevinConfigPath(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'devin', 'config.json')
  }
  return join(homedir(), '.config', 'devin', 'config.json')
}

export function getDevinManagedScriptFileName(): string {
  return process.platform === 'win32' ? `${DEVIN_SCRIPT_BASE}.cmd` : `${DEVIN_SCRIPT_BASE}.sh`
}

export function getDevinPosixManagedScriptFileName(): string {
  return `${DEVIN_SCRIPT_BASE}.sh`
}

export function getDevinManagedScriptPath(): string {
  return getSharedManagedScriptPath(getDevinManagedScriptFileName())
}

export function getDevinRemoteConfigPath(remoteHome: string): string {
  return `${remoteHome.replace(/\/$/, '')}/.config/devin/config.json`
}

export function getDevinManagedCommand(scriptPath: string): string {
  if (process.platform === 'win32') {
    // Why: Devin runs hooks through the platform shell on Windows; invoking the
    // .cmd via cmd.exe preserves spaces in the shared ~/.orca script path.
    return `cmd /d /s /c ""${scriptPath.replaceAll('"', '""')}""`
  }
  return wrapPosixHookCommand(scriptPath)
}

export function getDevinRemoteManagedCommand(scriptPath: string): string {
  return wrapPosixHookCommand(scriptPath)
}

export function applyDevinManagedHooks(
  config: HooksConfig,
  command: string,
  scriptFileName = getDevinManagedScriptFileName()
): HooksConfig {
  const nextHooks = { ...config.hooks }
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)

  for (const event of DEVIN_EVENTS) {
    const current = Array.isArray(nextHooks[event.eventName]) ? nextHooks[event.eventName] : []
    const cleaned = removeManagedCommands(current, isManagedCommand)
    const definition: HookDefinition = {
      ...event.definition,
      hooks: [{ type: 'command', command }]
    }
    nextHooks[event.eventName] = [...cleaned, definition]
  }

  return { ...config, hooks: nextHooks }
}

export function removeDevinManagedHooks(
  config: HooksConfig,
  scriptFileName = getDevinManagedScriptFileName()
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
