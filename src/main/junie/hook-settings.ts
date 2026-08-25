import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  removeManagedCommands,
  wrapPosixHookCommand,
  wrapWindowsCmdShellHookCommand,
  type HookDefinition,
  type HooksConfig
} from '../agent-hooks/installer-utils'

const JUNIE_SCRIPT_BASE = 'junie-hook'

// Why: Junie's full external-hook event set; there is no PostToolUse. Junie treats
// matchers as regexes and says omitted means "all" (Claude's "*" is not a valid regex).
export const JUNIE_EVENTS = [
  { eventName: 'SessionStart', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'UserPromptSubmit', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'PreToolUse', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'PermissionRequest', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'Stop', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'StopFailure', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'SessionEnd', definition: { hooks: [{ type: 'command', command: '' }] } }
] as const

// Why: user-level config only — Junie ignores project-level .junie/config.json hooks
// unless passed explicitly via --config-location.
export function getJunieConfigPath(): string {
  return join(getJunieHomeDir(), 'config.json')
}

function getJunieHomeDir(): string {
  const junieHome = process.env.JUNIE_HOME?.trim()
  return junieHome ? junieHome : join(homedir(), '.junie')
}

export function getJunieManagedScriptFileName(): string {
  return process.platform === 'win32' ? `${JUNIE_SCRIPT_BASE}.cmd` : `${JUNIE_SCRIPT_BASE}.sh`
}

export function getJuniePosixManagedScriptFileName(): string {
  return `${JUNIE_SCRIPT_BASE}.sh`
}

export function getJunieManagedScriptPath(): string {
  return getSharedManagedScriptPath(getJunieManagedScriptFileName())
}

export function getJunieRemoteConfigPath(remoteHome: string): string {
  return `${remoteHome.replace(/\/$/, '')}/.junie/config.json`
}

export function getJunieManagedCommand(scriptPath: string): string {
  if (process.platform === 'win32') {
    // Why: Junie runs hooks as `cmd.exe /c <command>`, so the command may be a shell line
    // rather than one spawnable token — it keeps the existence guard and stdin drain that
    // the argv[0] agents have to give up.
    return wrapWindowsCmdShellHookCommand(scriptPath)
  }
  return wrapPosixHookCommand(scriptPath)
}

export function getJunieRemoteManagedCommand(scriptPath: string): string {
  return wrapPosixHookCommand(scriptPath)
}

export function applyJunieManagedHooks(
  config: HooksConfig,
  command: string,
  scriptFileName = getJunieManagedScriptFileName()
): HooksConfig {
  const nextHooks = { ...config.hooks }
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)

  for (const event of JUNIE_EVENTS) {
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

export function removeJunieManagedHooks(
  config: HooksConfig,
  scriptFileName = getJunieManagedScriptFileName()
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
