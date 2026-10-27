import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  wrapPosixHookCommand,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import { readManagedHookEventsFromJson } from '../agent-hooks/managed-hooks-json-events'
import { wrapWindowsBatchHookCommand } from '../agent-hooks/windows-direct-cmd-hook-command'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import { parseMuseSettingsText } from './hook-config-json'

const MUSE_SCRIPT_BASE = 'muse-hook'

// Muse 1.3 uses Claude-shaped events; SubagentStart must not update parent-pane status.
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
  // Match the CLI's XDG_CONFIG_HOME resolution.
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
  // SFTP does not expose remote XDG_CONFIG_HOME; use Muse's default path.
  return `${remoteHome.replace(/\/$/, '')}/.config/muse/settings.json`
}

export function getMuseRemoteManagedHooksPath(remoteHome: string): string {
  return `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/${MUSE_MANAGED_HOOKS_FILE_NAME}`
}

export function getMuseManagedCommand(scriptPath: string): string {
  return process.platform === 'win32'
    ? wrapWindowsBatchHookCommand(scriptPath)
    : wrapPosixHookCommand(scriptPath)
}

export function getMuseRemoteManagedCommand(scriptPath: string): string {
  return wrapPosixHookCommand(scriptPath)
}

// This managed file contains no user content; unlike inline hooks, it can be replaced wholesale.
export function buildMuseManagedHooksFile(command: string): string {
  const hooks: Record<string, HookDefinition[]> = {}
  for (const event of MUSE_HOOK_EVENTS) {
    hooks[event] = [{ hooks: [buildManagedCommandHook(command)] }]
  }
  return `${JSON.stringify({ hooks }, null, 2)}\n`
}

export async function refreshMuseManagedHooksFile(): Promise<void> {
  const managedHooksPath = getMuseManagedHooksPath()
  const [settings, existing] = await Promise.all([
    readFile(getMuseConfigPath(), 'utf8').catch(() => null),
    readFile(managedHooksPath, 'utf8').catch(() => null)
  ])
  const config = settings === null ? null : parseMuseSettingsText(settings, 'Muse settings.json')
  if (!existing || config?.managed_hooks_path !== managedHooksPath) {
    return
  }
  const next = buildMuseManagedHooksFile(getMuseManagedCommand(getMuseManagedScriptPath()))
  if (existing !== next) {
    await refreshManagedScriptIfPresent(managedHooksPath, next)
  }
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
