import {
  hookDefinitionHasManagedCommand,
  removeManagedCommands
} from '../agent-hooks/installation/commands/managed-hook-command-matching'
import {
  buildManagedCommandHook,
  MANAGED_HOOK_TIMEOUT_MILLISECONDS,
  type HookDefinition,
  type HooksConfig
} from '../agent-hooks/installation/configuration/hook-config-schema'

// Gemini has no permission-prompt hook, so approvals cannot produce an Orca waiting state.
// Gemini uses BeforeTool; remove stale Claude-style PreToolUse registrations below.
export const GEMINI_EVENTS = ['BeforeAgent', 'AfterAgent', 'AfterTool', 'BeforeTool'] as const
export type GeminiEvent = (typeof GEMINI_EVENTS)[number]

export function buildInstalledGeminiHooks(
  config: HooksConfig,
  command: string,
  isManagedCommand: (command: string | undefined) => boolean,
  options: { events?: readonly GeminiEvent[]; onlyOwnedEvents?: boolean } = {}
): void {
  const nextHooks = { ...config.hooks }
  const managedEvents = new Set<string>(GEMINI_EVENTS)

  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (managedEvents.has(eventName) || !Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }

  for (const eventName of options.events ?? GEMINI_EVENTS) {
    const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
    // The refresh scan read the file earlier; skip events the user has since cleared of Orca entries.
    if (
      options.onlyOwnedEvents &&
      !current.some((definition) => hookDefinitionHasManagedCommand(definition, isManagedCommand))
    ) {
      continue
    }
    const cleaned = removeManagedCommands(current, isManagedCommand)
    const definition: HookDefinition = {
      // Gemini hook timeouts use milliseconds.
      hooks: [buildManagedCommandHook(command, MANAGED_HOOK_TIMEOUT_MILLISECONDS)]
    }
    nextHooks[eventName] = [...cleaned, definition]
  }

  config.hooks = nextHooks
}
