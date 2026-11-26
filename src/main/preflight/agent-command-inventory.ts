import { resolveLoginShellEnvironment } from '../startup/shell-environment/login-shell-environment'
import {
  probeWslCommandsOnPath,
  type WslPreflightTarget
} from '../ipc/preflight/preflight-wsl-agent-detection'
import {
  getWslGuestEnvironmentGeneration,
  invalidateWslGuestEnvironment
} from '../wsl/execution/wsl-guest-environment'
import { resolveWslDefaultDistro } from '../wsl/discovery/wsl-default-distro'
import { detectCommandsInInstallDirs } from '../../shared/agent-launch/installation/local-agent-install-dir-detection'
import {
  findCommandsOnLocalPath,
  type AgentPathMatch
} from '../ipc/command-path/command-path-batch'
import { buildLocalPreflightEnv } from '../ipc/preflight/preflight-local-env'
import { hasPathSeparatorToken } from '../../shared/agent-launch/installation/managed-agent-command-token'
import { isOrcaAgentRuntimePath } from '../managed-agent-cli/managed-agent-cli-path'
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

type CommandInventory = {
  found: Set<string>
  matches: Map<string, AgentPathMatch>
  // An incomplete WSL probe only settles commands it actually found.
  probed: ReadonlySet<string>
  incomplete?: boolean
}

const WSL_INVENTORY_RETRY_MS = 5_000

type InventoryMode = 'read' | 'detect' | 'revalidate' | 'refresh'
type InventoryScan = {
  sequence: number
  commands: Set<string>
  mode: InventoryMode
  targeted: boolean
  generation: number | undefined
}
type PendingInventory = {
  active: InventoryScan
  startedSequence: number
  queued?: InventoryScan
  result: Promise<CommandInventory | null>
}
type InventorySlot = {
  distro?: string
  generation?: number
  pending?: PendingInventory
  current?: CommandInventory
  retryAfter?: number
}
const scanPriority: Record<InventoryMode, number> = {
  read: 0,
  detect: 0,
  revalidate: 1,
  refresh: 2
}
let local: InventorySlot = {}
let profile: string | undefined

export function localInventory(): InventorySlot {
  const key = hasAppEnvironment() ? getProfileUserDataPath() : undefined
  if (key !== profile) {
    local = {}
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

async function scanLocalInventory(
  probed: ReadonlySet<string>,
  readLoginPath: boolean
): Promise<CommandInventory> {
  const localEnv = buildLocalPreflightEnv()
  const env = localEnv ?? (readLoginPath ? await resolveLoginShellEnvironment() : process.env)
  const pathEnv = env.PATH ?? Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1]
  const matches = new Map<string, AgentPathMatch>()
  const found = await findCommandsOnLocalPath([...probed], {
    env,
    inventory: { isRuntimePath: isOrcaAgentRuntimePath, matches }
  })
  const installs = await detectCommandsInInstallDirs(
    [...probed].filter((cmd) => !found.has(cmd) && !hasPathSeparatorToken(cmd)),
    pathEnv,
    { skipPathSearch: true }
  )
  for (const [command, user] of installs) {
    if (!isOrcaAgentRuntimePath(user)) {
      matches.set(command, { ...matches.get(command), user })
      found.add(command)
    }
  }
  return { matches, found, probed }
}

function inventoryGeneration(slot: InventorySlot): number | undefined {
  return slot.distro ? getWslGuestEnvironmentGeneration(slot.distro) : undefined
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
  return scanLocalInventory(
    scan.commands,
    !scan.targeted && (scan.mode === 'read' || scan.mode === 'revalidate')
  )
}

function publishInventory(
  slot: InventorySlot,
  result: CommandInventory,
  scan: InventoryScan
): void {
  const previous = scan.targeted && slot.generation === scan.generation ? slot.current : undefined
  const notScanned = (command: string) => !scan.commands.has(command)
  slot.current = previous
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
  slot.generation = scan.generation
}

export function readInventory(
  slot: InventorySlot,
  requested: readonly string[],
  mode: InventoryMode,
  targeted = false
): Promise<CommandInventory | null> {
  const generation = inventoryGeneration(slot)
  const current = slot.generation === generation ? slot.current : undefined
  if (
    mode === 'read' &&
    current &&
    !current.incomplete &&
    requested.every((cmd) => current.probed.has(cmd))
  ) {
    return Promise.resolve(current)
  }

  const commands = targeted
    ? requested
    : [...(slot.distro ? wslStockCommands : localStockCommands), ...requested]
  const pending = slot.pending
  if (pending) {
    const { active } = pending
    if (
      pending.queued ||
      active.generation !== generation ||
      scanPriority[mode] > scanPriority[active.mode] ||
      (mode === 'refresh' && active.sequence === pending.startedSequence) ||
      !commands.every((cmd) => active.commands.has(cmd))
    ) {
      const queued = pending.queued ?? {
        sequence: active.sequence + 1,
        commands: new Set(active.commands),
        mode,
        targeted: active.targeted,
        generation
      }
      for (const command of commands) {
        queued.commands.add(command)
      }
      if (scanPriority[mode] > scanPriority[queued.mode]) {
        queued.mode = mode
      }
      queued.targeted &&= targeted
      pending.queued = queued
    }
    return pending.result
  }
  if (mode !== 'refresh' && slot.generation === generation && Date.now() < (slot.retryAfter ?? 0)) {
    return Promise.resolve(current ?? null)
  }

  // The same promise carries all waiters through a queued scan. Caller deadlines never retire it.
  const batch: PendingInventory = {
    active: { sequence: 1, commands: new Set(commands), mode, targeted, generation },
    startedSequence: 0,
    result: Promise.resolve().then(async () => {
      for (;;) {
        const scan = batch.active
        batch.startedSequence = scan.sequence
        const result = await scanInventory(slot, scan).catch(() => null)
        if (batch.queued) {
          batch.active = batch.queued
          delete batch.queued
        } else if (scan.generation === inventoryGeneration(slot)) {
          delete slot.pending
          if (slot.distro && (!result || result.incomplete)) {
            slot.retryAfter = Date.now() + WSL_INVENTORY_RETRY_MS
          } else {
            delete slot.retryAfter
          }
          if (result) {
            publishInventory(slot, result, scan)
          } else if (slot.distro) {
            delete slot.current
            slot.generation = scan.generation
          }
          return result
        } else {
          batch.active = { ...scan, sequence: scan.sequence + 1 }
        }
      }
    })
  }
  slot.pending = batch
  return batch.result
}

const wsl = new Map<string, InventorySlot>()

export async function wslInventory(
  target: WslPreflightTarget,
  signal: AbortSignal
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
