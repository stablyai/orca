import { hookDefinitionHasManagedCommand } from '../commands/managed-hook-command-matching'
import type { HookDefinition } from './hook-config-schema'

export type OutdatedManagedEvents<Event> = { events: Event[]; outdated: boolean }

/** Events whose Orca entries differ from the single entry this build writes; retired events always count. */
export function findOutdatedManagedEvents<Event>(
  eventMap: Record<string, unknown>,
  managedEvents: readonly Event[],
  eventName: (event: Event) => string,
  isManagedCommand: (command: string | undefined) => boolean,
  isCurrentDefinition: (definition: HookDefinition, event: Event) => boolean
): OutdatedManagedEvents<Event> {
  const scan: OutdatedManagedEvents<Event> = { events: [], outdated: false }
  for (const [name, definitions] of Object.entries(eventMap)) {
    const managed = Array.isArray(definitions)
      ? (definitions as HookDefinition[]).filter((definition) =>
          hookDefinitionHasManagedCommand(definition, isManagedCommand)
        )
      : []
    if (managed.length === 0) {
      continue
    }
    const event = managedEvents.find((candidate) => eventName(candidate) === name)
    if (event === undefined) {
      scan.outdated = true
      continue
    }
    if (managed.length > 1 || !isCurrentDefinition(managed[0], event)) {
      scan.events.push(event)
      scan.outdated = true
    }
  }
  return scan
}
