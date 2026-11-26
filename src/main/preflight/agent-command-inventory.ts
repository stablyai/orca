import { probeWslCommandsOnPath } from '../ipc/preflight/preflight-wsl-agent-detection'
import {
  getWslGuestEnvironmentGeneration,
  invalidateWslGuestEnvironment
} from '../wsl/execution/wsl-guest-environment'
import { waitForPromiseWithSignal } from '../../shared/concurrency/abort-signal-reason'
import {
  publishInventory,
  type CommandInventory,
  type InventoryPublication,
  type InventoryPublications
} from './agent-command-inventory-publication'
import {
  readInventoryScan,
  type InventoryRead,
  type InventoryReadOptions
} from './agent-command-inventory-scan-read'
import {
  notifyScanChange,
  partialLocalAgentCommandInventory,
  scanLocalAgentCommandInventory,
  type LocalInventoryScan
} from './local-agent-command-inventory'

export const INVENTORY_WAIT_MS = 10_000
const INVENTORY_RETRY_MS = 5_000

type InventoryMode = 'read' | 'detect' | 'revalidate' | 'refresh'
export type InventoryScan = LocalInventoryScan & {
  publication: PromiseWithResolvers<InventoryPublication | null>
  complete: PromiseWithResolvers<InventoryPublication | null>
  successor?: InventoryScan
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
export type InventorySlot = InventoryPublications & {
  stockCommands: readonly string[]
  distro?: string
  shellPath?: string
  pending?: PendingInventory
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

export function currentInventoryPublication(
  slot: InventorySlot,
  kind: 'latest' | 'complete' = 'latest'
): InventoryPublication | undefined {
  const publication = kind === 'latest' ? slot.published : slot.completed
  return publication?.generation === inventoryGeneration(slot) ? publication : undefined
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
  const afterSetup = mode === 'refresh' && targeted
  const readLoginPath = (!targeted && (mode === 'read' || mode === 'revalidate')) || afterSetup
  return scanLocalAgentCommandInventory(
    commands,
    readLoginPath,
    slot.shellPath,
    mode === 'refresh' && (afterSetup || slot.shellPath !== undefined),
    progress,
    () => notifyScanChange(scan),
    controller.signal
  )
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
    progress: { found: new Set(), matches: new Map(), probed: new Set() },
    changed: Promise.withResolvers(),
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
          const previous = currentInventoryPublication(slot)?.inventory
          scan.partial = publishInventory(
            slot,
            partialLocalAgentCommandInventory(scan.progress, previous),
            scan,
            true
          )
          scan.publication.resolve(scan.partial)
          notifyScanChange(scan)
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
    if (scan.controller.signal.aborted) {
      scan.successor = pending.queued
    } else {
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
    scan.finished = true
    notifyScanChange(scan)
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
    qualifiesEarly,
    revalidateUnavailable = false,
    afterPublication,
    waitForCompletion = false
  }: InventoryReadOptions = {}
): InventoryRead {
  const generation = inventoryGeneration(slot)
  const published = currentInventoryPublication(slot)
  const current = published?.inventory
  const hasMatch =
    current && requested.some((cmd) => current.probed.has(cmd) && current.found.has(cmd))
  const settled =
    mode === 'read' &&
    published &&
    current &&
    (afterPublication === undefined || published.sequence > afterPublication) &&
    ((acceptAnyMatch && hasMatch) ||
      requested.every(
        (cmd) =>
          current.probed.has(cmd) &&
          (acceptAnyMatch || !current.incomplete || current.found.has(cmd))
      ))
  const revalidateMiss = settled && revalidateUnavailable && !hasMatch
  const readPublished = (): InventoryRead => ({
    wait: (signal) => waitForPromiseWithSignal(Promise.resolve(published ?? null), signal),
    snapshot: () => published ?? null
  })
  if (
    settled &&
    !revalidateMiss &&
    (!slot.pending || (!qualifiesEarly && slot.pending.active.mode !== 'refresh')) &&
    (!published?.partial || !waitForCompletion || acceptAnyMatch)
  ) {
    return readPublished()
  }

  const readScan = (scan: InventoryScan): InventoryRead =>
    readInventoryScan(scan, {
      requested,
      qualifiesEarly,
      waitForCompletion,
      snapshot: (current, inventory) =>
        slot.distro
          ? (currentInventoryPublication(slot) ?? null)
          : {
              inventory:
                inventory ??
                partialLocalAgentCommandInventory(
                  current.progress,
                  mode === 'refresh' && targeted
                    ? undefined
                    : currentInventoryPublication(slot)?.inventory
                ),
              generation,
              sequence: current.partial?.sequence ?? slot.published?.sequence ?? 0,
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
      (mode === 'refresh' && active.targeted && !targeted) ||
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
