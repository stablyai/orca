import type { AgentPathMatch } from '../ipc/command-path/command-path-batch'

export type CommandInventory = {
  found: Set<string>
  matches: Map<string, AgentPathMatch>
  // An incomplete WSL probe only settles commands it actually found.
  probed: ReadonlySet<string>
  incomplete?: boolean
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
  replaced: ReadonlySet<string>
): CommandInventory {
  const keep = (command: string) => !replaced.has(command)
  return previous
    ? {
        ...result,
        found: new Set([...result.found, ...[...previous.found].filter(keep)]),
        matches: new Map([
          ...result.matches,
          ...[...previous.matches].filter(([command]) => keep(command))
        ]),
        probed: new Set([...result.probed, ...[...previous.probed].filter(keep)])
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
