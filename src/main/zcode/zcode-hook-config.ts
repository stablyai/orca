import {
  MANAGED_HOOK_TIMEOUT_MILLISECONDS,
  createManagedCommandMatcher,
  isPlainObject
} from '../agent-hooks/installer-utils'

export const ZCODE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop'
] as const

export const ORCA_PREVIOUS_HOOKS_ENABLED_KEY = 'orcaPreviousHooksEnabled'

export type ZcodeHookCommand = {
  type?: string
  command?: string
  enabled?: boolean
  timeoutMs?: number
  [key: string]: unknown
}

export type ZcodeHookDefinition = {
  matcher?: string
  hooks?: ZcodeHookCommand[]
  [key: string]: unknown
}

export type ZcodeHooksRoot = {
  enabled?: boolean
  events?: Record<string, ZcodeHookDefinition[]>
  [key: string]: unknown
}

export type ZcodeConfig = {
  hooks?: ZcodeHooksRoot
  [key: string]: unknown
}

function asDefinitionArray(value: unknown): ZcodeHookDefinition[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((entry): entry is ZcodeHookDefinition => isPlainObject(entry))
}

function buildManagedHookCommand(command: string): ZcodeHookCommand {
  return {
    type: 'command',
    command,
    enabled: true,
    timeoutMs: MANAGED_HOOK_TIMEOUT_MILLISECONDS
  }
}

function stripManagedCommands(
  definitions: ZcodeHookDefinition[],
  isManagedCommand: (command: string | undefined) => boolean
): ZcodeHookDefinition[] {
  const next: ZcodeHookDefinition[] = []
  for (const definition of definitions) {
    if (!Array.isArray(definition.hooks)) {
      next.push(definition)
      continue
    }
    const hooks = definition.hooks
    const cleanedHooks = hooks.filter(
      (hook) => !isManagedCommand(typeof hook.command === 'string' ? hook.command : undefined)
    )
    if (hooks.length > 0 && cleanedHooks.length === 0) {
      continue
    }
    next.push({ ...definition, hooks: cleanedHooks })
  }
  return next
}

export function applyManagedZcodeHooks(
  config: ZcodeConfig,
  command: string,
  scriptFileName: string
): ZcodeConfig {
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  const hooksRoot: ZcodeHooksRoot = isPlainObject(config.hooks) ? { ...config.hooks } : {}
  const events: Record<string, ZcodeHookDefinition[]> = isPlainObject(hooksRoot.events)
    ? { ...hooksRoot.events }
    : {}
  const managedEvents = new Set<string>(ZCODE_HOOK_EVENTS)

  for (const [eventName, definitions] of Object.entries(events)) {
    if (managedEvents.has(eventName)) {
      continue
    }
    const cleaned = stripManagedCommands(asDefinitionArray(definitions), isManagedCommand)
    if (cleaned.length === 0) {
      delete events[eventName]
    } else {
      events[eventName] = cleaned
    }
  }

  for (const eventName of ZCODE_HOOK_EVENTS) {
    const current = stripManagedCommands(asDefinitionArray(events[eventName]), isManagedCommand)
    events[eventName] = [...current, { matcher: '*', hooks: [buildManagedHookCommand(command)] }]
  }

  if (!(ORCA_PREVIOUS_HOOKS_ENABLED_KEY in hooksRoot)) {
    hooksRoot[ORCA_PREVIOUS_HOOKS_ENABLED_KEY] = hooksRoot.enabled === true
  }
  hooksRoot.enabled = true
  hooksRoot.events = events
  return { ...config, hooks: hooksRoot }
}

export function removeManagedZcodeHooks(config: ZcodeConfig, scriptFileName: string): ZcodeConfig {
  if (!isPlainObject(config.hooks) || !isPlainObject(config.hooks.events)) {
    return config
  }
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  const hooksRoot: ZcodeHooksRoot = { ...config.hooks }
  const events: Record<string, ZcodeHookDefinition[]> = { ...hooksRoot.events }

  for (const [eventName, definitions] of Object.entries(events)) {
    const cleaned = stripManagedCommands(asDefinitionArray(definitions), isManagedCommand)
    if (cleaned.length === 0) {
      delete events[eventName]
    } else {
      events[eventName] = cleaned
    }
  }

  hooksRoot.events = events
  if (ORCA_PREVIOUS_HOOKS_ENABLED_KEY in hooksRoot) {
    hooksRoot.enabled = hooksRoot[ORCA_PREVIOUS_HOOKS_ENABLED_KEY] === true
    delete hooksRoot[ORCA_PREVIOUS_HOOKS_ENABLED_KEY]
  }
  return { ...config, hooks: hooksRoot }
}

export function readManagedZcodeHookEvents(config: ZcodeConfig, command: string): Set<string> {
  const present = new Set<string>()
  const events =
    isPlainObject(config.hooks) && isPlainObject(config.hooks.events) ? config.hooks.events : null
  if (!events) {
    return present
  }
  for (const eventName of ZCODE_HOOK_EVENTS) {
    const definitions = asDefinitionArray(events[eventName])
    if (
      definitions.some((definition) =>
        (Array.isArray(definition.hooks) ? definition.hooks : []).some(
          (hook) => hook.command === command
        )
      )
    ) {
      present.add(eventName)
    }
  }
  return present
}

export function isZcodeHooksEnabled(config: ZcodeConfig): boolean {
  return isPlainObject(config.hooks) && config.hooks.enabled === true
}
