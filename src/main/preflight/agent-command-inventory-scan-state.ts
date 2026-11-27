import type { InventoryScan, InventorySlot } from './agent-command-inventory'
import type { InventoryPublication } from './agent-command-inventory-publication'
import { notifyScanChange } from './local-agent-command-inventory'

export function createInventoryScan(
  commands: Iterable<string>,
  mode: InventoryScan['mode'],
  targeted: boolean,
  generation: number | undefined
): InventoryScan {
  return {
    publication: Promise.withResolvers(),
    complete: Promise.withResolvers(),
    controller: new AbortController(),
    progress: {
      found: new Set(),
      matches: new Map(),
      probed: new Set(),
      unresolvedPathHits: new Set()
    },
    changed: Promise.withResolvers(),
    started: false,
    commands: new Set(commands),
    mode,
    targeted,
    generation
  }
}

export function finishInventoryScan(
  scan: InventoryScan,
  publication: InventoryPublication | null
): void {
  scan.publication.resolve(publication)
  scan.complete.resolve(publication)
  scan.finished = true
  notifyScanChange(scan)
}

export function retireInventorySlot(slot: InventorySlot): void {
  slot.retired = true
  slot.onRetire?.()
  const pending = slot.pending
  delete slot.pending
  if (pending) {
    const { active, queued } = pending
    delete pending.queued
    active.controller.abort()
    finishInventoryScan(active, null)
    if (queued) {
      finishInventoryScan(queued, null)
    }
  }
}

export function retireInventorySlotIfStale(
  slot: InventorySlot,
  generation: number | undefined
): boolean {
  if (!slot.retired && slot.wslGeneration !== undefined && slot.wslGeneration !== generation) {
    retireInventorySlot(slot)
  }
  return slot.retired === true
}
