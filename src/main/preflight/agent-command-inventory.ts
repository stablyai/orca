import { probeWslCommandsOnPath } from '../ipc/preflight/preflight-wsl-agent-detection'
import {
  getWslGuestEnvironmentGeneration,
  invalidateWslGuestEnvironment
} from '../wsl/execution/wsl-guest-environment'
import type { AgentPathMatch } from '../ipc/command-path/command-path-batch'
import {
  partialLocalAgentCommandInventory,
  scanLocalAgentCommandInventory
} from './local-agent-command-inventory'

type CommandInventory = {
  found: Set<string>
  matches: Map<string, AgentPathMatch>
  // An incomplete WSL probe only settles commands it actually found.
  probed: ReadonlySet<string>
  incomplete?: boolean
}

export const INVENTORY_WAIT_MS = 10_000
const INVENTORY_RETRY_MS = 5_000

type InventoryMode = 'read' | 'detect' | 'revalidate' | 'refresh'
type InventoryScan = {
  publication: PromiseWithResolvers<InventoryPublication | null>
  complete: PromiseWithResolvers<InventoryPublication | null>
  controller: AbortController
  progress: Pick<CommandInventory, 'found' | 'matches'>
  partial?: InventoryPublication
  started: boolean
  commands: Set<string>
  mode: InventoryMode
  targeted: boolean
  generation: number | undefined
  revalidatesMiss?: readonly string[]
}
type PendingInventory = {
  active: InventoryScan
  queued?: InventoryScan
}
type InventoryPublication = {
  inventory: CommandInventory
  generation: number | undefined
  sequence: number
  partial?: boolean
}
type InventoryRead = {
  result: Promise<InventoryPublication | null>
  snapshot: () => InventoryPublication | null
}
export type InventorySlot = {
  stockCommands: readonly string[]
  distro?: string
  pending?: PendingInventory
  published?: InventoryPublication
  retry?: { after: number; generation: number | undefined }
  missRetry?: { after: number; generation: number | undefined }
}
const scanPriority: Record<InventoryMode, number> = {
  read: 0,
  detect: 0,
  revalidate: 1,
  refresh: 2
}
function inventoryGeneration(slot: InventorySlot): number | undefined {
  return slot.distro ? getWslGuestEnvironmentGeneration(slot.distro) : undefined
}

export function currentInventoryPublication(slot: InventorySlot): InventoryPublication | undefined {
  return slot.published?.generation === inventoryGeneration(slot) ? slot.published : undefined
}

async function scanInventory(
  slot: InventorySlot,
  scan: InventoryScan
): Promise<CommandInventory | null> {
  const { commands, mode, targeted, progress, controller } = scan
  if (slot.distro) {
    if (mode === 'refresh') {
      invalidateWslGuestEnvironment(slot.distro)
    }
    scan.generation = inventoryGeneration(slot)
    const probe = await probeWslCommandsOnPath({ distro: slot.distro }, [...commands])
    if (!probe) {
      return null
    }
    return {
      found: probe.found,
      matches: new Map(),
      probed: probe.environmentResolved ? commands : probe.found,
      incomplete: !probe.environmentResolved
    }
  }
  const readLoginPath = !targeted && (mode === 'read' || mode === 'revalidate')
  return scanLocalAgentCommandInventory(commands, readLoginPath, progress, controller.signal)
}

function publishInventory(
  slot: InventorySlot,
  result: CommandInventory,
  scan: InventoryScan,
  partial = false
): InventoryPublication {
  const previous =
    scan.targeted && slot.published?.generation === scan.generation
      ? slot.published?.inventory
      : undefined
  const notScanned = (command: string) => !scan.commands.has(command)
  const inventory = previous
    ? {
        ...result,
        found: new Set([...result.found, ...[...previous.found].filter(notScanned)]),
        matches: new Map([
          ...result.matches,
          ...[...previous.matches].filter(([command]) => notScanned(command))
        ]),
        probed: new Set([...result.probed, ...[...previous.probed].filter(notScanned)])
      }
    : result
  slot.published = {
    inventory,
    generation: scan.generation,
    sequence: (slot.published?.sequence ?? 0) + 1,
    partial
  }
  return slot.published
}

function createScan(
  commands: Iterable<string>,
  mode: InventoryMode,
  targeted: boolean,
  generation: number | undefined
): InventoryScan {
  return {
    publication: Promise.withResolvers(),
    complete: Promise.withResolvers(),
    controller: new AbortController(),
    progress: { found: new Set(), matches: new Map() },
    started: false,
    commands: new Set(commands),
    mode,
    targeted,
    generation
  }
}

function addScanRequest(
  scan: InventoryScan,
  commands: readonly string[],
  mode: InventoryMode,
  targeted: boolean
): void {
  for (const command of commands) {
    scan.commands.add(command)
  }
  if (scanPriority[mode] > scanPriority[scan.mode]) {
    scan.mode = mode
  }
  scan.targeted &&= targeted
}

async function runInventoryScans(slot: InventorySlot, pending: PendingInventory): Promise<void> {
  for (;;) {
    const scan = pending.active
    scan.started = true
    const timer = slot.distro
      ? undefined
      : setTimeout(() => {
          const snapshot = partialLocalAgentCommandInventory(scan.progress)
          scan.partial = publishInventory(slot, snapshot, scan, true)
          scan.publication.resolve(scan.partial)
          if (pending.queued) {
            scan.controller.abort()
          }
        }, INVENTORY_WAIT_MS)
    const result = await scanInventory(slot, scan).catch(() => null)
    clearTimeout(timer)
    if (scan.generation !== inventoryGeneration(slot)) {
      continue
    }
    let publication: InventoryPublication | null = scan.partial ?? null
    if (!scan.controller.signal.aborted) {
      if (
        result &&
        scan.revalidatesMiss?.every((cmd) => result.probed.has(cmd) && !result.found.has(cmd))
      ) {
        slot.missRetry = { after: Date.now() + INVENTORY_RETRY_MS, generation: scan.generation }
      }
      if (slot.distro && (!result || result.incomplete)) {
        slot.retry = { after: Date.now() + INVENTORY_RETRY_MS, generation: scan.generation }
      } else {
        delete slot.retry
      }
      if (result) {
        publication = publishInventory(slot, result, scan)
      } else if (slot.distro && slot.published) {
        // Preserve the display list while requiring a new probe for launches.
        slot.published.inventory = {
          ...slot.published.inventory,
          probed: new Set(),
          incomplete: true
        }
      }
    }
    scan.publication.resolve(publication)
    scan.complete.resolve(publication)
    if (pending.queued) {
      pending.active = pending.queued
      delete pending.queued
    } else {
      delete slot.pending
      return
    }
  }
}

export function readInventory(
  slot: InventorySlot,
  requested: readonly string[],
  mode: InventoryMode,
  {
    targeted = false,
    acceptAnyMatch = false,
    revalidateUnavailable = false,
    waitForCompletion = false
  }: {
    targeted?: boolean
    acceptAnyMatch?: boolean
    revalidateUnavailable?: boolean
    waitForCompletion?: boolean
  } = {}
): InventoryRead {
  const generation = inventoryGeneration(slot)
  const published = currentInventoryPublication(slot)
  const current = published?.inventory
  const hasMatch =
    current && requested.some((cmd) => current.probed.has(cmd) && current.found.has(cmd))
  const settled =
    mode === 'read' &&
    current &&
    ((acceptAnyMatch && hasMatch) ||
      requested.every(
        (cmd) => current.probed.has(cmd) && (!current.incomplete || current.found.has(cmd))
      ))
  const revalidateMiss = settled && revalidateUnavailable && !hasMatch
  const readPublished = (): InventoryRead => ({
    result: Promise.resolve(published ?? null),
    snapshot: () => published ?? null
  })
  if (settled && !revalidateMiss && (!published?.partial || !waitForCompletion || acceptAnyMatch)) {
    return readPublished()
  }

  const readScan = (scan: InventoryScan): InventoryRead => ({
    result: (waitForCompletion ? scan.complete : scan.publication).promise,
    snapshot: () =>
      slot.distro
        ? (currentInventoryPublication(slot) ?? null)
        : {
            inventory: partialLocalAgentCommandInventory(scan.progress),
            generation,
            sequence: scan.partial?.sequence ?? slot.published?.sequence ?? 0,
            partial: true
          }
  })
  const commands = targeted ? requested : [...slot.stockCommands, ...requested]
  const pending = slot.pending
  if (pending) {
    const { active } = pending
    if (!active.started) {
      addScanRequest(active, commands, mode, targeted)
      return readScan(active)
    }
    if (
      mode === 'refresh' ||
      scanPriority[mode] > scanPriority[active.mode] ||
      !commands.every((cmd) => active.commands.has(cmd))
    ) {
      pending.queued ??= createScan(commands, mode, targeted, generation)
      addScanRequest(pending.queued, commands, mode, targeted)
      if (active.partial) {
        active.controller.abort()
      }
      return readScan(pending.queued)
    }
    return readScan(active)
  }
  const missRetry = slot.missRetry
  if (
    revalidateMiss &&
    missRetry &&
    missRetry.generation === generation &&
    Date.now() < missRetry.after
  ) {
    return readPublished()
  }
  const retry = slot.retry
  if (mode !== 'refresh' && retry && retry.generation === generation && Date.now() < retry.after) {
    return readPublished()
  }

  const active = createScan(commands, mode, targeted, generation)
  active.revalidatesMiss = revalidateMiss ? requested : undefined
  const batch = { active }
  slot.pending = batch
  void Promise.resolve().then(() => runInventoryScans(slot, batch))
  return readScan(active)
}
