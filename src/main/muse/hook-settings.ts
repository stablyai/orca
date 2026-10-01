import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  wrapPosixHookCommand,
  wrapWindowsHookCommand,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import { readManagedHookEventsFromJson } from '../agent-hooks/managed-hooks-json-events'

const MUSE_SCRIPT_BASE = 'muse-hook'

// Muse 1.3 emits Claude-shaped lifecycle events; absent matchers cover every tool.
// SubagentStart names the internal child sessions whose hooks must not drive pane status.
export const MUSE_HOOK_EVENTS = [
  'SessionStart',
  'SubagentStart',
  'SessionEnd',
  'Notification',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'StopFailure'
] as const

export const MUSE_MANAGED_HOOKS_FILE_NAME = 'muse-hooks.json'

function getMuseConfigDir(home: string): string {
  // Why: honor XDG_CONFIG_HOME like the CLI does; default matches muse's own
  // `~/.config/muse` resolution.
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  return xdg ? join(xdg, 'muse') : join(home, '.config', 'muse')
}

export function getMuseConfigPath(): string {
  return join(getMuseConfigDir(homedir()), 'settings.json')
}

export function getMuseManagedScriptFileName(): string {
  return process.platform === 'win32' ? `${MUSE_SCRIPT_BASE}.cmd` : `${MUSE_SCRIPT_BASE}.sh`
}

export function getMuseManagedScriptPath(): string {
  return getSharedManagedScriptPath(getMuseManagedScriptFileName())
}

export function getMuseManagedHooksPath(): string {
  return getSharedManagedScriptPath(MUSE_MANAGED_HOOKS_FILE_NAME)
}

export function getMuseRemoteConfigPath(remoteHome: string): string {
  // Why: remote XDG_CONFIG_HOME is unknown over SFTP; default matches muse's own resolution.
  return `${remoteHome.replace(/\/$/, '')}/.config/muse/settings.json`
}

export function getMuseRemoteManagedHooksPath(remoteHome: string): string {
  return `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/${MUSE_MANAGED_HOOKS_FILE_NAME}`
}

export function getMuseManagedCommand(scriptPath: string): string {
  return process.platform === 'win32'
    ? wrapWindowsHookCommand(scriptPath)
    : wrapPosixHookCommand(scriptPath)
}

export function getMuseRemoteManagedCommand(scriptPath: string): string {
  return wrapPosixHookCommand(scriptPath)
}

// Why: the managed file is fully Orca-owned (muse runs it without a trust
// step via `managed_hooks_path`), so generate it wholesale — no user content
// to preserve, unlike an inline `hooks` block in settings.json.
export function buildMuseManagedHooksFile(command: string): string {
  const hooks: Record<string, HookDefinition[]> = {}
  for (const event of MUSE_HOOK_EVENTS) {
    hooks[event] = [{ hooks: [buildManagedCommandHook(command)] }]
  }
  return `${JSON.stringify({ hooks }, null, 2)}\n`
}

export function readManagedMuseHookEvents(
  parsed: unknown,
  isManagedCommand: (command: string | undefined) => boolean
): Set<string> {
  return readManagedHookEventsFromJson(parsed, MUSE_HOOK_EVENTS, isManagedCommand)
}

export function getMuseManagedCommandMatcher(): (command: string | undefined) => boolean {
  return createManagedCommandMatcher(getMuseManagedScriptFileName())
}
