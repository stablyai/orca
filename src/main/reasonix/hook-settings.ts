import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  isPlainObject,
  wrapWindowsCmdHookCommand
} from '../agent-hooks/installer-utils'
import { reasonixConfigRoots } from '../../shared/reasonix-config-roots'
import { quoteStartupArg } from '../../shared/tui-agent-startup-shell'

export const REASONIX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'StopFailure',
  'SessionEnd'
] as const

export function getReasonixConfigPath(configHome?: string): string {
  return join(
    configHome ?? reasonixConfigRoots(homedir(), process.platform, process.env).configHome,
    'settings.json'
  )
}

export function getReasonixScriptName(): string {
  return process.platform === 'win32' ? 'reasonix-hook.cmd' : 'reasonix-hook.sh'
}

export function getReasonixScriptPath(): string {
  return getSharedManagedScriptPath(getReasonixScriptName())
}

export function getReasonixManagedCommand(
  path: string,
  platform: NodeJS.Platform = process.platform
): string {
  return platform === 'win32' ? wrapWindowsCmdHookCommand(path) : quoteStartupArg(path, 'posix')
}

const matchesManaged = createManagedCommandMatcher('reasonix-hook')

export function parseReasonixHookSettings(text: string | null): Record<string, unknown> {
  const config: unknown = text === null ? {} : JSON.parse(text)
  if (!isPlainObject(config) || (config.hooks !== undefined && !isPlainObject(config.hooks))) {
    throw new Error('Invalid Reasonix settings.json')
  }
  if (isPlainObject(config.hooks)) {
    for (const entries of Object.values(config.hooks)) {
      if (
        !Array.isArray(entries) ||
        entries.some((entry) => !isPlainObject(entry) || typeof entry.command !== 'string')
      ) {
        throw new Error('Invalid Reasonix native hook definitions')
      }
    }
  }
  return config
}

export function updateReasonixManagedHooks(
  config: Record<string, unknown>,
  command?: string
): Record<string, unknown> {
  const hooks = { ...(isPlainObject(config.hooks) ? config.hooks : {}) }
  for (const event of REASONIX_HOOK_EVENTS) {
    const entries: unknown[] = Array.isArray(hooks[event]) ? hooks[event] : []
    const kept = entries.filter(
      (entry) =>
        !isPlainObject(entry) || typeof entry.command !== 'string' || !matchesManaged(entry.command)
    )
    if (command) {
      kept.push({ command, timeout: 10000 })
    }
    if (kept.length) {
      hooks[event] = kept
    } else {
      delete hooks[event]
    }
  }
  return { ...config, hooks }
}

export function reasonixManagedHookEvents(config: Record<string, unknown>): Set<string> {
  const hooks = isPlainObject(config.hooks) ? config.hooks : {}
  return new Set(
    REASONIX_HOOK_EVENTS.filter((event) => {
      const entries: unknown[] = Array.isArray(hooks[event]) ? hooks[event] : []
      return entries.some(
        (entry) =>
          isPlainObject(entry) && typeof entry.command === 'string' && matchesManaged(entry.command)
      )
    })
  )
}
