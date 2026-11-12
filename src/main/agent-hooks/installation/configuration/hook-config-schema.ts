export type HookCommandConfig = {
  type: 'command'
  command: string
  args?: string[]
  timeout?: number
  async?: boolean
  statusMessage?: string
  [key: string]: unknown
}

export type HookDefinition = {
  matcher?: string
  command?: string
  bash?: string
  powershell?: string
  hooks?: HookCommandConfig[]
  [key: string]: unknown
}

export type HooksConfig = {
  hooks?: Record<string, HookDefinition[]>
  [key: string]: unknown
}

// Host-level backstop independent of curl and provider-specific timeouts.
export const MANAGED_HOOK_TIMEOUT_SECONDS = 10

export const MANAGED_HOOK_TIMEOUT_MILLISECONDS = MANAGED_HOOK_TIMEOUT_SECONDS * 1000

// Claude-shaped schemas nest command hooks; Cursor puts command on the definition itself.
export function buildManagedCommandHook(
  command: string,
  timeout = MANAGED_HOOK_TIMEOUT_SECONDS
): HookCommandConfig {
  return { type: 'command', command, timeout }
}

export function buildManagedCommandDefinition(command: string): HookDefinition {
  return { command, timeout: MANAGED_HOOK_TIMEOUT_SECONDS }
}
