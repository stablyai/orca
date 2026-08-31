import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  removeManagedCommands,
  type HookDefinition,
  type HooksConfig
} from '../agent-hooks/installer-utils'

export const GROK_TOOL_EVENT_MATCHER = '.*'

export const GROK_EVENTS = [
  { eventName: 'SessionStart', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'UserPromptSubmit', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'Stop', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'StopFailure', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'SessionEnd', definition: { hooks: [{ type: 'command', command: '' }] } },
  {
    // Why: Orca needs the pre-event to show in-flight tools and detect ask_user_question waits;
    // PostToolUse arrives only after both states have ended.
    eventName: 'PreToolUse',
    definition: { matcher: GROK_TOOL_EVENT_MATCHER, hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PostToolUse',
    definition: { matcher: GROK_TOOL_EVENT_MATCHER, hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PostToolUseFailure',
    definition: { matcher: GROK_TOOL_EVENT_MATCHER, hooks: [{ type: 'command', command: '' }] }
  },
  { eventName: 'Notification', definition: { hooks: [{ type: 'command', command: '' }] } }
] as const

export function buildInstalledGrokConfig(
  config: HooksConfig,
  command: string,
  scriptFileName: string
): void {
  const nextHooks = { ...config.hooks }
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  const managedEvents = new Set<string>(GROK_EVENTS.map((event) => event.eventName))

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

  for (const event of GROK_EVENTS) {
    const current = Array.isArray(nextHooks[event.eventName]) ? nextHooks[event.eventName] : []
    const cleaned = removeManagedCommands(current, isManagedCommand)
    const definition: HookDefinition = {
      ...event.definition,
      hooks: [buildManagedCommandHook(command)]
    }
    nextHooks[event.eventName] = [...cleaned, definition]
  }

  config.hooks = nextHooks
}
