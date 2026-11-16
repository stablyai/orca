import {
  buildManagedCommandHook,
  type HookDefinition,
  type HooksConfig
} from '../agent-hooks/installation/configuration/hook-config-schema'
import {
  createManagedCommandMatcher,
  hookDefinitionHasManagedCommand,
  removeManagedCommands
} from '../agent-hooks/installation/commands/managed-hook-command-matching'
import { isPlainObject } from '../agent-hooks/installation/configuration/hooks-json-read'

// SessionStart clears prompt/tool caches on resume before the next user prompt.
export const DROID_EVENTS = [
  { eventName: 'SessionStart', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'UserPromptSubmit', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'Stop', definition: { hooks: [{ type: 'command', command: '' }] } },
  // SubagentStop must not count as parent completion.
  { eventName: 'SubagentStop', definition: { hooks: [{ type: 'command', command: '' }] } },
  {
    eventName: 'PreToolUse',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PostToolUse',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  { eventName: 'Notification', definition: { hooks: [{ type: 'command', command: '' }] } }
] as const

// Why: Droid's hook event enum has no PermissionRequest and a /hooks save leaves it out of hooks.json.
const EVENTS_DROID_NEVER_LOADS = new Set(['PermissionRequest'])

/** A `/hooks` save writes event names at the top level; non-event keys such as `hooksDisabled` sit beside them. */
export type DroidHooksFile = Record<string, unknown>

function eventDefinitions(file: DroidHooksFile, eventName: string): HookDefinition[] | null {
  const value = file[eventName]
  return Array.isArray(value) ? value : null
}

/** Carries settings.json events hooks.json lacks into it: a hooks.json event replaces the settings one wholesale. */
function carrySettingsHooksIntoHooksFile(hooksFile: DroidHooksFile, settings: HooksConfig): void {
  const settingsHooks: unknown = settings.hooks
  if (!isPlainObject(settingsHooks)) {
    return
  }
  for (const [eventName, definitions] of Object.entries(settingsHooks)) {
    if (
      !Array.isArray(definitions) ||
      EVENTS_DROID_NEVER_LOADS.has(eventName) ||
      Object.hasOwn(hooksFile, eventName)
    ) {
      continue
    }
    hooksFile[eventName] = structuredClone(definitions)
  }
}

/** Removes Orca's entries from an event map; true if any were found. Non-event keys are never touched. */
function stripManagedEntries(
  events: Record<string, unknown>,
  isManagedCommand: (command: string | undefined) => boolean,
  keepEvents?: ReadonlySet<string>
): boolean {
  let changed = false
  for (const [eventName, value] of Object.entries(events)) {
    if (keepEvents?.has(eventName) || !Array.isArray(value)) {
      continue
    }
    if (
      !value.some((definition) => hookDefinitionHasManagedCommand(definition, isManagedCommand))
    ) {
      continue
    }
    const cleaned = removeManagedCommands(value, isManagedCommand)
    if (cleaned.length === 0) {
      delete events[eventName]
    } else {
      events[eventName] = cleaned
    }
    changed = true
  }
  return changed
}

function stripManagedEntriesFromSettings(
  settings: HooksConfig,
  isManagedCommand: (command: string | undefined) => boolean
): boolean {
  const settingsHooks: unknown = settings.hooks
  return isPlainObject(settingsHooks) ? stripManagedEntries(settingsHooks, isManagedCommand) : false
}

/** The two user-level files Droid merges per event, as parsed from disk. */
export type DroidHookFiles = { hooksFile: DroidHooksFile; settings: HooksConfig }

/** Removes Orca's entries from both files, reporting which ones changed so only those are written. */
export function applyDroidRemove(
  { hooksFile, settings }: DroidHookFiles,
  scriptFileName: string
): { hooksChanged: boolean; settingsChanged: boolean } {
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  return {
    hooksChanged: stripManagedEntries(hooksFile, isManagedCommand),
    settingsChanged: stripManagedEntriesFromSettings(settings, isManagedCommand)
  }
}

/** The install mutation local, SSH and WSL share: Orca's entries move into hooks.json and out of settings.json. */
export function applyDroidInstall(
  { hooksFile, settings }: DroidHookFiles,
  command: string,
  scriptFileName: string
): { settingsChanged: boolean } {
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  carrySettingsHooksIntoHooksFile(hooksFile, settings)

  // Why: sweep Orca's entries out of events it no longer subscribes to.
  stripManagedEntries(
    hooksFile,
    isManagedCommand,
    new Set<string>(DROID_EVENTS.map((event) => event.eventName))
  )

  for (const event of DROID_EVENTS) {
    const current = eventDefinitions(hooksFile, event.eventName) ?? []
    const definition: HookDefinition = {
      ...event.definition,
      hooks: [buildManagedCommandHook(command)]
    }
    hooksFile[event.eventName] = [...removeManagedCommands(current, isManagedCommand), definition]
  }

  return { settingsChanged: stripManagedEntriesFromSettings(settings, isManagedCommand) }
}
