import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  removeManagedCommands,
  wrapPosixHookCommand,
  wrapWindowsCmdHookCommand,
  type HookDefinition,
  type HooksConfig
} from '../agent-hooks/installer-utils'

const BOB_SCRIPT_BASE = 'bob-hook'

// Why: Bob's own BOB_HOOK_EVENTS constant — the only events its settings schema accepts.
// It has no Notification or PermissionRequest hook, so `waiting` rides on PreToolUse.
export const BOB_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop'
] as const

export function getBobConfigPath(): string {
  // Why: Bob resolves this from os.homedir() on every platform (no APPDATA branch, no env override).
  return join(homedir(), '.bob', 'settings', 'settings.json')
}

export function getBobManagedScriptFileName(): string {
  return process.platform === 'win32' ? `${BOB_SCRIPT_BASE}.cmd` : `${BOB_SCRIPT_BASE}.sh`
}

export function getBobPosixManagedScriptFileName(): string {
  return `${BOB_SCRIPT_BASE}.sh`
}

export function getBobManagedScriptPath(): string {
  return getSharedManagedScriptPath(getBobManagedScriptFileName())
}

export function getBobRemoteConfigPath(remoteHome: string): string {
  return `${remoteHome.replace(/\/$/, '')}/.bob/settings/settings.json`
}

export function getBobManagedCommand(scriptPath: string): string {
  // Why (#18875 doctrine): Bob runs hooks via child_process.exec — cmd.exe on Windows — so a
  // cmd-safe path needs no interpreter hop at all, and the encoded launcher survives only for a
  // path cmd.exe would mangle. Bob ignores empty stdout, so no neutral-JSON `|| echo {}` tail.
  return process.platform === 'win32'
    ? wrapWindowsCmdHookCommand(scriptPath)
    : wrapPosixHookCommand(scriptPath)
}

export function getBobRemoteManagedCommand(scriptPath: string): string {
  return wrapPosixHookCommand(scriptPath)
}

export function applyBobManagedHooks(
  config: HooksConfig,
  command: string,
  scriptFileName = getBobManagedScriptFileName()
): HooksConfig {
  const nextHooks = { ...config.hooks }
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)

  for (const eventName of BOB_EVENTS) {
    const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
    const cleaned = removeManagedCommands(current, isManagedCommand)
    // Why: Bob's definition schema is `.strict()` and treats an omitted matcher as match-all,
    // so emit only `hooks` — a stray key makes Bob discard every global hook as invalid.
    const definition: HookDefinition = { hooks: [buildManagedCommandHook(command)] }
    nextHooks[eventName] = [...cleaned, definition]
  }

  return { ...config, hooks: nextHooks }
}

export function removeBobManagedHooks(
  config: HooksConfig,
  scriptFileName = getBobManagedScriptFileName()
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

  return { config: { ...config, hooks: nextHooks }, changed }
}
