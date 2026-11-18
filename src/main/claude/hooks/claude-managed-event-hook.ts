import { buildManagedCommandHook } from '../../agent-hooks/installation/configuration/hook-config-schema'
import type { HookCommandConfig } from '../../agent-hooks/installation/configuration/hook-config-schema'
import { CLAUDE_ASYNC_OBSERVATIONAL_EVENTS } from './claude-managed-hook-events'
import {
  CLAUDE_HOOK_SETTINGS,
  getManagedLifecycleHook,
  getRemoteManagedEventCommand,
  type NativeHookFormOptions
} from './hook-settings'

// Why 130 s: a worker's request waits up to Orca's 122 s hold, past Claude's own 2:00 auto-block.
const CLAUDE_PERMISSION_HOOK_TIMEOUT_SECONDS = 130

/** The managed entry for one Claude hook event; only PermissionRequest waits longer than the shared timeout. */
export function getManagedEventHook(
  eventName: string,
  scriptPath: string,
  settings = CLAUDE_HOOK_SETTINGS,
  nativeHookPath: string | null = null,
  options: NativeHookFormOptions = {}
): HookCommandConfig {
  // Observational events never feed Claude a decision, so their hook may run without blocking the
  // turn; `withPreviousManagedAsync` still lets a user's explicit async choice override this default.
  const withObservationalAsync = (hook: HookCommandConfig): HookCommandConfig =>
    options.asyncObservational === true && CLAUDE_ASYNC_OBSERVATIONAL_EVENTS.includes(eventName)
      ? { ...hook, async: true }
      : hook
  return process.platform === 'win32'
    ? withObservationalAsync(getManagedLifecycleHook(scriptPath, settings, nativeHookPath, options))
    : withObservationalAsync(
        buildManagedCommandHook(
          getRemoteManagedEventCommand(eventName, scriptPath),
          eventName === 'PermissionRequest' ? CLAUDE_PERMISSION_HOOK_TIMEOUT_SECONDS : undefined
        )
      )
}
