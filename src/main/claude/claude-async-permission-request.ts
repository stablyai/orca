import {
  MANAGED_HOOK_TIMEOUT_SECONDS,
  type HookCommandConfig
} from '../agent-hooks/installation/configuration/hook-config-schema'

// Read by the hook script: this entry runs async, so Claude ignores its output and nothing waits on it.
const ASYNC_FLAG = 'export ORCA_HOOK_ASYNC=1; '

/** A managed PermissionRequest entry the user made async prints `{}` first, never waits for an
 *  answer, and keeps the shared timeout. Only POSIX commands can carry the flag. */
export function withClaudeAsyncPermissionRequest(
  eventName: string,
  hook: HookCommandConfig,
  posixCommand: boolean
): HookCommandConfig {
  return eventName === 'PermissionRequest' && hook.async === true && posixCommand
    ? asyncForm(hook)
    : hook
}

/** The installed forms an event may take; async ones are appended so an index still names its launcher. */
export function claudeManagedHookForms(
  eventName: string,
  forms: HookCommandConfig[]
): HookCommandConfig[] {
  return eventName === 'PermissionRequest' ? [...forms, ...forms.map(asyncForm)] : forms
}

function asyncForm(hook: HookCommandConfig): HookCommandConfig {
  return {
    ...hook,
    command: `${ASYNC_FLAG}${hook.command}`,
    timeout: MANAGED_HOOK_TIMEOUT_SECONDS
  }
}
