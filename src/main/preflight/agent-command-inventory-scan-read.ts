import { waitForPromiseWithSignal } from '../../shared/concurrency/abort-signal-reason'
import type { AgentPathMatch } from '../ipc/command-path/command-path-batch'
import type { InventoryScan } from './agent-command-inventory'
import type { CommandInventory, InventoryPublication } from './agent-command-inventory-publication'
import {
  partialLocalAgentCommandInventory,
  waitForLocalInventoryCommands
} from './local-agent-command-inventory'

export type InventoryRead = {
  wait: (signal: AbortSignal) => Promise<InventoryPublication | null>
  snapshot: () => InventoryPublication | null
  scannedMatch?: (program: string, match: AgentPathMatch | undefined) => boolean
}

export type InventoryReadOptions = {
  targeted?: boolean
  acceptAnyMatch?: boolean
  qualifiesEarly?: (match: AgentPathMatch | undefined) => boolean
  revalidateUnavailable?: boolean
  allowFallbackMisses?: boolean
  afterPublication?: number
  waitForCompletion?: boolean
}

export function readInventoryPublication(
  publication: InventoryPublication | undefined
): InventoryRead {
  return {
    wait: (signal) => waitForPromiseWithSignal(Promise.resolve(publication ?? null), signal),
    snapshot: () => publication ?? null
  }
}

export function readInventoryScan(
  scan: InventoryScan,
  {
    requested,
    waitForCompletion,
    qualifiesEarly,
    wsl,
    readPublished
  }: {
    requested: readonly string[]
    waitForCompletion: boolean
    qualifiesEarly?: (match: AgentPathMatch | undefined) => boolean
    wsl: boolean
    readPublished: () => InventoryPublication | undefined
  }
): InventoryRead {
  const snapshot = (inventory?: CommandInventory): InventoryPublication | null => {
    const published = readPublished()
    if (wsl) {
      return published ?? null
    }
    return {
      inventory:
        inventory ?? partialLocalAgentCommandInventory(scan.progress, published?.inventory),
      generation: scan.generation,
      sequence: scan.partial?.sequence ?? published?.sequence ?? 0,
      partial: true
    }
  }
  return {
    wait: async (signal) => {
      if (!waitForCompletion) {
        return waitForPromiseWithSignal(scan.publication.promise, signal)
      }
      for (;;) {
        if (qualifiesEarly) {
          const inventory = await waitForLocalInventoryCommands(
            scan,
            requested,
            qualifiesEarly,
            () => snapshot()?.inventory,
            signal
          )
          if (inventory) {
            return snapshot(inventory)
          }
        }
        const publication = await waitForPromiseWithSignal(scan.complete.promise, signal)
        const successor = scan.successor
        if (!successor || !requested.every((command) => successor.commands.has(command))) {
          return publication
        }
        scan = successor
      }
    },
    snapshot: () => snapshot(),
    scannedMatch: (program, match) =>
      match !== undefined && scan.progress.matches.get(program) === match
  }
}
