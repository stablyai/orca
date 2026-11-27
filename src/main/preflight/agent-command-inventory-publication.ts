import type { TuiAgentDetectionRuntime } from '../../shared/agent-launch/catalog/tui-agent-config-types'
import type { AgentPathMatch } from '../ipc/command-path/command-path-batch'

let readInventoryOverrideCommands: (
  runtime: TuiAgentDetectionRuntime
) => readonly string[] = () => []

export function configureInventoryOverrideCommands(
  read: typeof readInventoryOverrideCommands
): void {
  readInventoryOverrideCommands = read
}

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
  command: string,
  allowFallbackMisses = true
): boolean {
  return (
    (inventory.probed.has(command) && (!inventory.incomplete || inventory.found.has(command))) ||
    (allowFallbackMisses &&
      !inventory.incomplete &&
      inventory.fallbackMisses?.has(command) === true)
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
              pinPrevious ? { user: match.user, runtimeHit: match.runtimeHit } : match
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
  slot: InventoryPublications & { stockCommands: readonly string[]; distro?: string },
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
  const retained = new Set([
    ...slot.stockCommands,
    ...readInventoryOverrideCommands(slot.distro ? 'wsl' : process.platform)
  ])
  const completed = slot.completed && retainInventoryCommands(slot.completed, retained)
  const previous = completed?.generation === generation ? completed?.inventory : undefined
  const publication = {
    inventory: !partial && targeted ? mergeInventory(inventory, previous, commands) : inventory,
    generation,
    sequence: (slot.published?.sequence ?? 0) + 1,
    partial
  }
  // A scan may still owe a result for a command that changed while it was running.
  slot.published = retainInventoryCommands(publication, retained)
  slot.completed = partial ? completed : slot.published
  return publication
}

function retainInventoryCommands(
  publication: InventoryPublication,
  retained: ReadonlySet<string>
): InventoryPublication {
  const { inventory } = publication
  const hasObsolete = (commands: Iterable<string>): boolean => {
    for (const command of commands) {
      if (!retained.has(command)) {
        return true
      }
    }
    return false
  }
  if (
    !hasObsolete(inventory.probed) &&
    !hasObsolete(inventory.found) &&
    !hasObsolete(inventory.matches.keys()) &&
    (!inventory.fallbackMisses || !hasObsolete(inventory.fallbackMisses))
  ) {
    return publication
  }
  const keep = (command: string) => retained.has(command)
  return {
    ...publication,
    inventory: {
      ...inventory,
      found: new Set([...inventory.found].filter(keep)),
      matches: new Map([...inventory.matches].filter(([command]) => keep(command))),
      probed: new Set([...inventory.probed].filter(keep)),
      fallbackMisses:
        inventory.fallbackMisses && new Set([...inventory.fallbackMisses].filter(keep))
    }
  }
}

export function completeInventoryAfter(
  publication: InventoryPublication | undefined,
  sequence: number,
  commands: readonly string[],
  allowFallbackMisses: boolean
): InventoryPublication | undefined {
  return publication &&
    publication.sequence > sequence &&
    !publication.inventory.incomplete &&
    commands.every((command) =>
      isInventoryListCommandSettled(publication.inventory, command, allowFallbackMisses)
    )
    ? publication
    : undefined
}
