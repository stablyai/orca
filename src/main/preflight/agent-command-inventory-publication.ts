import type { AgentPathMatch } from '../ipc/command-path/command-path-batch'

export type CommandInventory = {
  found: Set<string>
  matches: Map<string, AgentPathMatch>
  // An incomplete WSL probe only settles commands it actually found.
  probed: ReadonlySet<string>
  fallbackMisses?: ReadonlySet<string>
  incomplete?: boolean
}

export function isInventoryListCommandSettled(
  inventory: CommandInventory,
  command: string
): boolean {
  return (
    (inventory.probed.has(command) && (!inventory.incomplete || inventory.found.has(command))) ||
    (!inventory.incomplete && inventory.fallbackMisses?.has(command) === true)
  )
}

export type InventoryPublication = {
  inventory: CommandInventory
  generation: number | undefined
  sequence: number
  partial?: boolean
}

export type InventoryPublications = {
  published?: InventoryPublication
  completed?: InventoryPublication
}

export function mergeInventory(
  result: CommandInventory,
  previous: CommandInventory | undefined,
  replaced: ReadonlySet<string>,
  pinPrevious = false
): CommandInventory {
  const keep = (command: string) => !replaced.has(command)
  return previous
    ? {
        ...result,
        found: new Set([...result.found, ...[...previous.found].filter(keep)]),
        matches: new Map([
          ...result.matches,
          ...[...previous.matches]
            .filter(([command]) => keep(command))
            .map(([command, match]): [string, AgentPathMatch] => [
              command,
              pinPrevious ? { user: match.user } : match
            ])
        ]),
        probed: new Set([...result.probed, ...[...previous.probed].filter(keep)]),
        fallbackMisses: previous.fallbackMisses
          ? new Set([
              ...(result.fallbackMisses ?? []),
              ...[...previous.fallbackMisses].filter(keep)
            ])
          : result.fallbackMisses
      }
    : result
}

export function publishInventory(
  slot: InventoryPublications,
  inventory: CommandInventory,
  {
    targeted,
    commands,
    generation
  }: {
    targeted: boolean
    commands: ReadonlySet<string>
    generation: number | undefined
  },
  partial = false
): InventoryPublication {
  const previous = slot.completed?.generation === generation ? slot.completed?.inventory : undefined
  const publication = {
    inventory: !partial && targeted ? mergeInventory(inventory, previous, commands) : inventory,
    generation,
    sequence: (slot.published?.sequence ?? 0) + 1,
    partial
  }
  slot.published = publication
  if (!partial) {
    slot.completed = publication
  }
  return publication
}
