import { waitForPromiseWithSignal } from '../../shared/concurrency/abort-signal-reason'
import type { AgentPathMatch } from '../ipc/command-path/command-path-batch'
import type { InventoryScan } from './agent-command-inventory'
import type { CommandInventory, InventoryPublication } from './agent-command-inventory-publication'
import { waitForLocalInventoryCommands } from './local-agent-command-inventory'

export type InventoryRead = {
  wait: (signal: AbortSignal) => Promise<InventoryPublication | null>
  snapshot: () => InventoryPublication | null
}

export function readInventoryScan(
  scan: InventoryScan,
  {
    requested,
    waitForCompletion,
    qualifiesEarly,
    snapshot
  }: {
    requested: readonly string[]
    waitForCompletion: boolean
    qualifiesEarly?: (match: AgentPathMatch | undefined) => boolean
    snapshot: (scan: InventoryScan, inventory?: CommandInventory) => InventoryPublication | null
  }
): InventoryRead {
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
            () => snapshot(scan)?.inventory,
            signal
          )
          if (inventory) {
            return snapshot(scan, inventory)
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
    snapshot: () => snapshot(scan)
  }
}
