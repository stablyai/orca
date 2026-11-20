import {
  buildManagedCommandHook,
  MANAGED_HOOK_TIMEOUT_SECONDS,
  type HookDefinition,
  type HooksConfig
} from '../agent-hooks/installation/configuration/hook-config-schema'
import {
  createManagedCommandMatcher,
  hookDefinitionHasManagedCommand,
  removeManagedCommands
} from '../agent-hooks/installation/commands/managed-hook-command-matching'
import {
  ANTIGRAVITY_EVENTS,
  ANTIGRAVITY_HOOK_BUNDLE_NAME,
  ANTIGRAVITY_MANAGED_SCRIPT_FILE_NAMES,
  type AntigravityEvent
} from './hook-events'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function getBundle(config: HooksConfig): Record<string, unknown> {
  const existing = config[ANTIGRAVITY_HOOK_BUNDLE_NAME]
  return isRecord(existing) ? { ...existing } : {}
}

export function hasManagedCommand(definitions: HookDefinition[], command: string): boolean {
  return definitions.some(
    (definition) =>
      definition.command === command ||
      (Array.isArray(definition.hooks) && definition.hooks.some((hook) => hook.command === command))
  )
}

export function createAntigravityManagedCommandMatcher(): (command: string | undefined) => boolean {
  const matchers = ANTIGRAVITY_MANAGED_SCRIPT_FILE_NAMES.map((scriptFileName) =>
    createManagedCommandMatcher(scriptFileName)
  )
  return (command) => matchers.some((matcher) => matcher(command))
}

export function bundleHasStaleManagedCommand(
  bundle: Record<string, unknown>,
  isManagedCommand: (command: string | undefined) => boolean,
  currentCommands: ReadonlySet<string>
): boolean {
  for (const definitions of Object.values(bundle)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    for (const definition of definitions as HookDefinition[]) {
      if (!hookDefinitionHasManagedCommand(definition, isManagedCommand)) {
        continue
      }
      const commands = [
        definition.command,
        definition.bash,
        definition.powershell,
        ...(Array.isArray(definition.hooks) ? definition.hooks.map((hook) => hook.command) : [])
      ]
      if (
        commands.some(
          (command) =>
            command !== undefined && isManagedCommand(command) && !currentCommands.has(command)
        )
      ) {
        return true
      }
    }
  }
  return false
}

function buildEventDefinition(event: AntigravityEvent, command: string): HookDefinition {
  if (event.schema === 'tool') {
    return {
      matcher: '*',
      hooks: [buildManagedCommandHook(command)]
    }
  }
  return { type: 'command', command, timeout: MANAGED_HOOK_TIMEOUT_SECONDS }
}

function removeManagedCommandsFromBundle(
  bundle: Record<string, unknown>,
  isManagedCommand: (command: string | undefined) => boolean,
  keepEvents: ReadonlySet<string> = new Set()
): Record<string, unknown> {
  const next = { ...bundle }
  for (const [eventName, definitions] of Object.entries(next)) {
    if (keepEvents.has(eventName) || !Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions as HookDefinition[], isManagedCommand)
    if (cleaned.length === 0) {
      delete next[eventName]
    } else {
      next[eventName] = cleaned
    }
  }
  return next
}

export function buildInstalledConfig(
  config: HooksConfig,
  commandForEvent: (event: AntigravityEvent) => string,
  isManagedCommand: (command: string | undefined) => boolean,
  options: { events?: readonly AntigravityEvent[]; onlyOwnedEvents?: boolean } = {}
): void {
  // Retired events lose Orca entries; current events are rewritten below.
  const bundle = removeManagedCommandsFromBundle(
    getBundle(config),
    isManagedCommand,
    new Set(ANTIGRAVITY_EVENTS.map((event) => event.eventName))
  )

  for (const event of options.events ?? ANTIGRAVITY_EVENTS) {
    const current = Array.isArray(bundle[event.eventName])
      ? (bundle[event.eventName] as HookDefinition[])
      : []
    // The refresh scan read the file earlier; skip events the user has since cleared of Orca entries.
    if (
      options.onlyOwnedEvents &&
      !current.some((definition) => hookDefinitionHasManagedCommand(definition, isManagedCommand))
    ) {
      continue
    }
    const cleaned = removeManagedCommands(current, isManagedCommand)
    bundle[event.eventName] = [...cleaned, buildEventDefinition(event, commandForEvent(event))]
  }

  config[ANTIGRAVITY_HOOK_BUNDLE_NAME] = bundle
}

export function removeInstalledConfig(config: HooksConfig): void {
  const isManagedCommand = createAntigravityManagedCommandMatcher()
  const bundle = removeManagedCommandsFromBundle(getBundle(config), isManagedCommand)
  if (Object.keys(bundle).length === 0) {
    delete config[ANTIGRAVITY_HOOK_BUNDLE_NAME]
    return
  }
  config[ANTIGRAVITY_HOOK_BUNDLE_NAME] = bundle
}
