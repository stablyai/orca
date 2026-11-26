import { buildManagedCommandHook } from '../../agent-hooks/installation/configuration/hook-config-schema'
import type { HookCommandConfig } from '../../agent-hooks/installation/configuration/hook-config-schema'
import {
  CLAUDE_HOOK_SETTINGS,
  getManagedLifecycleHook,
  getRemoteManagedEventCommand,
  type NativeHookFormOptions
} from './hook-settings'
import { CLAUDE_PRE_TOOL_USE_ANSWER_WAIT_SECONDS } from './claude-hook-decision-script'

// Why 130 s: a worker's request waits up to Orca's 122 s hold, past Claude's own 2:00 auto-block.
const CLAUDE_PERMISSION_HOOK_TIMEOUT_SECONDS = 130
// Why 30 s: past the script's wait for Orca, a loaded host needs the rest to start and spool.
const CLAUDE_PRE_TOOL_USE_HOOK_TIMEOUT_SECONDS = CLAUDE_PRE_TOOL_USE_ANSWER_WAIT_SECONDS + 22

/** The managed entry for one Claude hook event; local POSIX PermissionRequest outlasts Orca's hold. */
export function getManagedEventHook(
  eventName: string,
  scriptPath: string,
  settings = CLAUDE_HOOK_SETTINGS,
  nativeHookPath: string | null = null,
  options: NativeHookFormOptions = {}
): HookCommandConfig {
  if (process.platform === 'win32') {
    return getManagedLifecycleHook(scriptPath, settings, nativeHookPath, options)
  }
  const hook = getPosixManagedEventHook(eventName, scriptPath)
  return eventName === 'PermissionRequest'
    ? { ...hook, timeout: CLAUDE_PERMISSION_HOOK_TIMEOUT_SECONDS }
    : hook
}

/** The POSIX managed entry, local or remote; PreToolUse outlasts the script's wait for Orca. */
export function getPosixManagedEventHook(eventName: string, scriptPath: string): HookCommandConfig {
  return buildManagedCommandHook(
    getRemoteManagedEventCommand(eventName, scriptPath),
    eventName === 'PreToolUse' ? CLAUDE_PRE_TOOL_USE_HOOK_TIMEOUT_SECONDS : undefined
  )
}
