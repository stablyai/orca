import { homedir } from 'node:os'
import { join, posix as pathPosix } from 'node:path'
import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  wrapPosixHookCommand,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import { wrapWindowsBatchHookCommand } from '../agent-hooks/windows-direct-cmd-hook-command'
import { readManagedHookEventsFromJson } from '../agent-hooks/managed-hooks-json-events'

const DSH_SCRIPT_BASE = 'dsh-hook'

/** Register only bridge-supported events; unsupported Claude events never fire in DSH. */
export const DSH_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop'
] as const

export const DSH_MANAGED_HOOKS_FILE_NAME = 'dsh-hooks.json'

export function getDshHome(): string {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/** Use the home layer so every profile inherits hooks without editing user-owned profile layers. */
export function getDshConfigPath(): string {
  return join(getDshHome(), 'cordis.patch.yml')
}

export function getDshRemoteConfigPath(remoteHome: string): string {
  // SFTP cannot resolve remote DSH_HOME; use the launcher's default home.
  return pathPosix.join(remoteHome.replace(/\/$/, ''), '.dsh', 'cordis.patch.yml')
}

export function getDshManagedScriptFileName(): string {
  return process.platform === 'win32' ? `${DSH_SCRIPT_BASE}.cmd` : `${DSH_SCRIPT_BASE}.sh`
}

export function getDshManagedScriptPath(): string {
  return getSharedManagedScriptPath(getDshManagedScriptFileName())
}

export function getDshManagedHooksPath(): string {
  return getSharedManagedScriptPath(DSH_MANAGED_HOOKS_FILE_NAME)
}

export function getDshRemoteManagedHooksPath(remoteHome: string): string {
  return pathPosix.join(
    remoteHome.replace(/\/$/, ''),
    '.orca',
    'agent-hooks',
    DSH_MANAGED_HOOKS_FILE_NAME
  )
}

export function getDshManagedCommand(scriptPath: string): string {
  return process.platform === 'win32'
    ? wrapWindowsBatchHookCommand(scriptPath)
    : wrapPosixHookCommand(scriptPath)
}

export function getDshRemoteManagedCommand(scriptPath: string): string {
  return wrapPosixHookCommand(scriptPath)
}

export function getDshManagedCommandMatcher(): (command: string | undefined) => boolean {
  return createManagedCommandMatcher(getDshManagedScriptFileName())
}

/** This is Orca-owned config: DSH reads the explicit path rather than a user hooks.json convention. */
export function buildDshManagedHooksFile(command: string): string {
  const hooks: Record<string, HookDefinition[]> = {}
  for (const event of DSH_HOOK_EVENTS) {
    hooks[event] = [{ hooks: [buildManagedCommandHook(command)] }]
  }
  return `${JSON.stringify({ hooks }, null, 2)}\n`
}

export function readManagedDshHookEvents(
  parsed: unknown,
  isManagedCommand: (command: string | undefined) => boolean
): Set<string> {
  return readManagedHookEventsFromJson(parsed, DSH_HOOK_EVENTS, isManagedCommand)
}
