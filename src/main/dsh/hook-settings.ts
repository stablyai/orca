import { homedir } from 'node:os'
import { join, posix as pathPosix } from 'node:path'
import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  wrapPosixHookCommand,
  wrapWindowsHookCommand,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import { readManagedHookEventsFromJson } from '../agent-hooks/managed-hooks-json-events'

const DSH_SCRIPT_BASE = 'dsh-hook'

/**
 * The events DeepSeek Harness's own Claude-Code hook bridge
 * (`@deepseek-ai/dsh-hooks-claude-code`) can fire. This is a strict subset of Claude's:
 * the bridge documents no `Notification`, no `PermissionRequest` and no `SessionEnd`,
 * and registering an unsupported event name makes it register nothing for that event.
 * `normalizeDshEvent` is written against exactly this list.
 */
export const DSH_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop'
] as const

export const DSH_MANAGED_HOOKS_FILE_NAME = 'dsh-hooks.json'

/** `$DSH_HOME`, matching the launcher's own `DSH_HOME ?? ~/.dsh` resolution. */
export function getDshHome(): string {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/**
 * The home-level patch layer.
 *
 * Why here and not in a profile: DSH composes every profile as bundle patches, then the
 * profile's own `cordis.patch.yml`, then this file. Installing one layer above every
 * profile means a pane the user started themselves — any profile, including one Orca
 * never launched — still reports status, and Orca never edits a profile the user owns.
 */
export function getDshConfigPath(): string {
  return join(getDshHome(), 'cordis.patch.yml')
}

export function getDshRemoteConfigPath(remoteHome: string): string {
  // Why: a remote $DSH_HOME is unknown over SFTP; default matches the launcher's own resolution.
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
  // Why: DSH runs hooks through `ctx.shell`, which the base profile binds to bash
  // everywhere except Windows, where it binds to PowerShell — the same split these two
  // wrappers already encode.
  return process.platform === 'win32'
    ? wrapWindowsHookCommand(scriptPath)
    : wrapPosixHookCommand(scriptPath)
}

export function getDshRemoteManagedCommand(scriptPath: string): string {
  return wrapPosixHookCommand(scriptPath)
}

export function getDshManagedCommandMatcher(): (command: string | undefined) => boolean {
  return createManagedCommandMatcher(getDshManagedScriptFileName())
}

/**
 * The managed hooks file is Orca's outright: DSH has no user-owned `hooks.json`
 * convention of its own, and the bridge reads whatever single path it is pointed at. So
 * generate it wholesale rather than merging into someone's file.
 */
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
