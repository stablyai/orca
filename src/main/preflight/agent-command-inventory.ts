import { probeWslCommandsOnPath } from '../ipc/preflight/preflight-wsl-agent-detection'
import {
  getWslGuestEnvironmentGeneration,
  invalidateWslGuestEnvironment
} from '../wsl/execution/wsl-guest-environment'
import {
  isInventoryListCommandSettled,
  publishInventory,
  type CommandInventory,
  type InventoryPublication,
  type InventoryPublications
} from './agent-command-inventory-publication'
import {
  readInventoryPublication,
  readInventoryScan,
  type InventoryRead,
  type InventoryReadOptions
} from './agent-command-inventory-scan-read'
import {
  createInventoryScan,
  finishInventoryScan,
  retireInventorySlotIfStale
} from './agent-command-inventory-scan-state'
import {
  notifyScanChange,
  partialLocalAgentCommandInventory,
  scanLocalAgentCommandInventory,
  type LocalInventoryScan
} from './local-agent-command-inventory'
import { INVENTORY_WAIT_MS } from '../../shared/agent-launch/installation/agent-inventory-deadline'

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
  wslGeneration?: number
  shellPath?: string
  retired?: true
  onRetire?: () => void
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
  if (slot.retired) {
    return undefined
  }
  const publication = kind === 'latest' ? slot.published : slot.completed
  return publication?.generation === inventoryGeneration(slot) ? publication : undefined
}

async function scanInventory(
  slot: InventorySlot,
  scan: InventoryScan
): Promise<CommandInventory | null> {
  const { commands, mode, targeted } = scan
  if (slot.distro) {
    if (mode === 'refresh') {
      invalidateWslGuestEnvironment(slot.distro)
      slot.wslGeneration = getWslGuestEnvironmentGeneration(slot.distro)
    }
    scan.generation = inventoryGeneration(slot)
    const probe = await probeWslCommandsOnPath(
      { distro: slot.distro },
      [...commands],
      scan.controller.signal
    )
    if (!probe) {
      return null
    }
    scan.progress.found = probe.found
    scan.progress.matches = probe.matches
    return {
      found: probe.found,
      matches: probe.matches,
      probed: probe.environmentResolved ? commands : probe.found,
      incomplete: !probe.environmentResolved
    }
  }
  const readLoginPath = !targeted && (mode === 'read' || mode === 'revalidate')
  return scanLocalAgentCommandInventory(
    commands,
    readLoginPath,
    slot.shellPath,
    mode === 'refresh' || mode === 'revalidate',
    scan
  )
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
  while (slot.pending === pending && !retireInventorySlotIfStale(slot, inventoryGeneration(slot))) {
    const scan = pending.active
    scan.started = true
    const timer = slot.distro
      ? undefined
      : setTimeout(() => {
          if (slot.pending !== pending) {
            return
          }
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
    if (slot.pending !== pending || retireInventorySlotIfStale(slot, inventoryGeneration(slot))) {
      return
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
    finishInventoryScan(scan, publication)
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
    allowFallbackMisses = true,
    afterPublication,
    waitForCompletion = false
  }: InventoryReadOptions = {}
): InventoryRead {
  const generation = inventoryGeneration(slot)
  if (retireInventorySlotIfStale(slot, generation)) {
    return readInventoryPublication(undefined)
  }
  const published = currentInventoryPublication(slot, slot.distro ? 'complete' : 'latest')
  const current = published?.inventory
  const hasMatch =
    current && requested.some((cmd) => current.probed.has(cmd) && current.found.has(cmd))
  const settled =
    mode === 'read' &&
    published &&
    current &&
    (afterPublication === undefined || published.sequence > afterPublication) &&
    ((acceptAnyMatch && hasMatch) ||
      requested.every((cmd) =>
        acceptAnyMatch
          ? current.probed.has(cmd)
          : isInventoryListCommandSettled(current, cmd, allowFallbackMisses)
      ))
  const revalidateMiss =
    mode === 'read' &&
    revalidateUnavailable &&
    !hasMatch &&
    (settled || requested.some((cmd) => current?.fallbackMisses?.has(cmd)))
  if (
    settled &&
    !revalidateMiss &&
    (!slot.pending || (!qualifiesEarly && slot.pending.active.mode !== 'refresh')) &&
    (!published?.partial || !waitForCompletion || acceptAnyMatch)
  ) {
    return readInventoryPublication(published)
  }

  const readScan = (scan: InventoryScan): InventoryRead =>
    readInventoryScan(scan, {
      requested,
      qualifiesEarly,
      waitForCompletion,
      wsl: slot.distro !== undefined,
      isRetired: () => slot.retired === true,
      readPublished: () => currentInventoryPublication(slot)
    })
  mode = revalidateMiss && !slot.distro ? 'revalidate' : mode
  const commands = targeted ? requested : [...slot.stockCommands, ...requested]
  const pending = slot.pending
  if (pending) {
    const { active } = pending
    const sharesLocalCapture =
      !slot.distro &&
      !active.loginPathCaptured &&
      mode === 'refresh' &&
      (active.mode === 'refresh' || active.mode === 'revalidate')
    if (!active.started || sharesLocalCapture) {
      addScanRequest(active, commands, mode, targeted)
      active.revalidatesMiss ??= revalidateMiss ? requested : undefined
      return readScan(active)
    }
    if (
      mode === 'refresh' ||
      scanPriority[mode] > scanPriority[active.mode] ||
      !commands.every((cmd) => active.commands.has(cmd))
    ) {
      pending.queued ??= createInventoryScan(commands, mode, targeted, generation)
      addScanRequest(pending.queued, commands, mode, targeted)
      pending.queued.revalidatesMiss ??= revalidateMiss ? requested : undefined
      if (active.partial) {
        active.controller.abort()
      }
      return readScan(pending.queued)
    }
    return readScan(active)
  }
  const missRetry = slot.missRetry
  if (
    settled &&
    revalidateMiss &&
    missRetry &&
    missRetry.generation === generation &&
    Date.now() < missRetry.after
  ) {
    return readInventoryPublication(published)
  }
  const retry = slot.retry
  if (mode !== 'refresh' && retry && retry.generation === generation && Date.now() < retry.after) {
    return readInventoryPublication(published)
  }

  const active = createInventoryScan(commands, mode, targeted, generation)
  active.revalidatesMiss = revalidateMiss ? requested : undefined
  const batch = { active }
  slot.pending = batch
  void Promise.resolve().then(() => runInventoryScans(slot, batch))
  return readScan(active)
}
