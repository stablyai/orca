import {
  probeWslCommandsOnPath,
  type WslPreflightTarget
} from '../ipc/preflight/preflight-wsl-agent-detection'
import {
  getWslGuestEnvironmentGeneration,
  invalidateWslGuestEnvironment
} from '../wsl/execution/wsl-guest-environment'
import { resolveWslDefaultDistro } from '../wsl/discovery/wsl-default-distro'
import type { AgentPathMatch } from '../ipc/command-path/command-path-batch'
import {
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  getTuiAgentDetectionProbeCommands
} from '../../shared/agent-launch/catalog/tui-agent-detection-commands'
import { stockLaunchProgram } from '../../shared/agent-launch/startup/managed-agent-launch-program'
import { TUI_AGENT_CONFIG, isTuiAgent } from '../../shared/agent-launch/catalog/tui-agent-config'
import { hasAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../shared/concurrency/abort-signal-reason'
import { scanLocalAgentCommandInventory } from './local-agent-command-inventory'

type CommandInventory = {
  found: Set<string>
  matches: Map<string, AgentPathMatch>
  // An incomplete WSL probe only settles commands it actually found.
  probed: ReadonlySet<string>
  incomplete?: boolean
}

const INVENTORY_RETRY_MS = 5_000

type InventoryMode = 'read' | 'detect' | 'revalidate' | 'refresh'
type InventoryScan = {
  result: PromiseWithResolvers<CommandInventory | null>
  started: boolean
  commands: Set<string>
  mode: InventoryMode
  targeted: boolean
  generation: number | undefined
  revalidatesMiss?: boolean
}
type PendingInventory = {
  active: InventoryScan
  queued?: InventoryScan
}
type InventoryPublication = {
  inventory: CommandInventory
  generation: number | undefined
  sequence: number
}
export type InventorySlot = {
  distro?: string
  localEnv?: () => NodeJS.ProcessEnv | undefined
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
let local: InventorySlot | undefined
let profile: string | undefined

export function localInventory(localEnv: NonNullable<InventorySlot['localEnv']>): InventorySlot {
  const key = hasAppEnvironment() ? getProfileUserDataPath() : undefined
  if (!local || key !== profile) {
    local = { localEnv }
    profile = key
  }
  return local
}

function stockCommands(platform: NodeJS.Platform, runtime: NodeJS.Platform | 'wsl' = platform) {
  return [
    ...getTuiAgentDetectionProbeCommands(KNOWN_TUI_AGENT_DETECTION_COMMANDS, runtime),
    ...Object.keys(TUI_AGENT_CONFIG)
      .filter(isTuiAgent)
      .map((agent) => stockLaunchProgram(agent, platform))
  ]
}

const localStockCommands = stockCommands(process.platform)
const wslStockCommands = stockCommands('linux', 'wsl')

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
  if (slot.distro) {
    if (scan.mode === 'refresh') {
      invalidateWslGuestEnvironment(slot.distro)
    }
    scan.generation = inventoryGeneration(slot)
    const probe = await probeWslCommandsOnPath({ distro: slot.distro }, [...scan.commands])
    return (
      probe && {
        found: probe.found,
        matches: new Map(),
        probed: probe.environmentResolved ? scan.commands : probe.found,
        incomplete: !probe.environmentResolved
      }
    )
  }
  const readLoginPath = !scan.targeted && (scan.mode === 'read' || scan.mode === 'revalidate')
  return scanLocalAgentCommandInventory(scan.commands, readLoginPath, slot.localEnv?.())
}

function publishInventory(
  slot: InventorySlot,
  result: CommandInventory,
  scan: InventoryScan
): void {
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
    sequence: (slot.published?.sequence ?? 0) + 1
  }
}

function createScan(
  commands: Iterable<string>,
  mode: InventoryMode,
  targeted: boolean,
  generation: number | undefined
): InventoryScan {
  return {
    result: Promise.withResolvers(),
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
): Promise<CommandInventory | null> {
  for (const command of commands) {
    scan.commands.add(command)
  }
  if (scanPriority[mode] > scanPriority[scan.mode]) {
    scan.mode = mode
  }
  scan.targeted &&= targeted
  return scan.result.promise
}

async function runInventoryScans(slot: InventorySlot, pending: PendingInventory): Promise<void> {
  for (;;) {
    const scan = pending.active
    scan.started = true
    const result = await scanInventory(slot, scan).catch(() => null)
    if (scan.generation !== inventoryGeneration(slot)) {
      continue
    }
    if (scan.revalidatesMiss) {
      slot.missRetry = { after: Date.now() + INVENTORY_RETRY_MS, generation: scan.generation }
    }
    if (slot.distro && (!result || result.incomplete)) {
      slot.retry = { after: Date.now() + INVENTORY_RETRY_MS, generation: scan.generation }
    } else {
      delete slot.retry
    }
    if (result) {
      publishInventory(slot, result, scan)
    } else if (slot.distro && slot.published) {
      // Preserve the display list but require a new probe before answering a launch.
      slot.published.inventory = {
        ...slot.published.inventory,
        probed: new Set(),
        incomplete: true
      }
    }
    // Active waiters receive this publication even when later requests need a successor.
    scan.result.resolve(result)
    if (!pending.queued) {
      delete slot.pending
      return
    }
    pending.active = pending.queued
    delete pending.queued
  }
}

export function readInventory(
  slot: InventorySlot,
  requested: readonly string[],
  mode: InventoryMode,
  {
    targeted = false,
    acceptAnyMatch = false,
    revalidateUnavailable = false
  }: { targeted?: boolean; acceptAnyMatch?: boolean; revalidateUnavailable?: boolean } = {}
): Promise<CommandInventory | null> {
  const generation = inventoryGeneration(slot)
  const current = currentInventoryPublication(slot)?.inventory
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
  if (settled && !revalidateMiss) {
    return Promise.resolve(current)
  }

  const commands = targeted
    ? requested
    : [...(slot.distro ? wslStockCommands : localStockCommands), ...requested]
  const pending = slot.pending
  if (pending) {
    const { active } = pending
    if (!active.started) {
      return addScanRequest(active, commands, mode, targeted)
    }
    if (
      mode === 'refresh' ||
      scanPriority[mode] > scanPriority[active.mode] ||
      !commands.every((cmd) => active.commands.has(cmd))
    ) {
      pending.queued ??= createScan(active.commands, mode, active.targeted, generation)
      return addScanRequest(pending.queued, commands, mode, targeted)
    }
    return active.result.promise
  }
  const missRetry = slot.missRetry
  if (
    revalidateMiss &&
    missRetry &&
    missRetry.generation === generation &&
    Date.now() < missRetry.after
  ) {
    return Promise.resolve(current ?? null)
  }
  const retry = slot.retry
  if (mode !== 'refresh' && retry && retry.generation === generation && Date.now() < retry.after) {
    return Promise.resolve(current ?? null)
  }

  const batch: PendingInventory = {
    active: createScan(commands, mode, targeted, generation)
  }
  if (revalidateMiss) {
    batch.active.revalidatesMiss = true
  }
  slot.pending = batch
  void Promise.resolve().then(() => runInventoryScans(slot, batch))
  return batch.active.result.promise
}

const wsl = new Map<string, InventorySlot>()

export async function wslInventory(
  target: WslPreflightTarget,
  signal?: AbortSignal
): Promise<InventorySlot | undefined> {
  const distro =
    target.distro?.trim() || (await waitForPromiseWithSignal(resolveWslDefaultDistro(), signal))
  throwIfSignalAborted(signal)
  if (typeof distro !== 'string') {
    return undefined
  }
  const key = distro.toLowerCase()
  const slot = wsl.get(key) ?? { distro }
  wsl.set(key, slot)
  return slot
}
