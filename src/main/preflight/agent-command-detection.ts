import { resolveLoginShellEnvironment } from '../startup/shell-environment/login-shell-environment'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
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
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight/preflight-runtime-target'
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
import type { AgentStartupShell } from '../../shared/agent-launch/startup/tui-agent-startup-shell'

type CommandInventory = {
  found: Set<string>
  matches: Map<string, AgentPathMatch>
  probed: ReadonlySet<string>
}

type InventoryMode = 'read' | 'detect' | 'revalidate' | 'refresh'
type InventoryScan = {
  commands: Set<string>
  mode: InventoryMode
  targeted: boolean
  generation: number | undefined
}
type PendingInventory = {
  active: InventoryScan
  queued?: InventoryScan
  result: Promise<CommandInventory | null>
}
type InventorySlot = {
  distro?: string
  generation?: number
  pending?: PendingInventory
  current?: CommandInventory
}
const scanPriority: Record<InventoryMode, number> = {
  read: 0,
  detect: 0,
  revalidate: 1,
  refresh: 2
}
let local: InventorySlot = {}
let profile: string | undefined

function localInventory(): InventorySlot {
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
    const found = await probeWslCommandsOnPath({ distro: slot.distro }, [...scan.commands])
    return found && { found, matches: new Map(), probed: scan.commands }
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
  const notProbed = (command: string) => !result.probed.has(command)
  slot.current = previous
    ? {
        found: new Set([...result.found, ...[...previous.found].filter(notProbed)]),
        matches: new Map([
          ...result.matches,
          ...[...previous.matches].filter(([command]) => notProbed(command))
        ]),
        probed: new Set([...previous.probed, ...result.probed])
      }
    : result
  slot.generation = scan.generation
}

function readInventory(
  slot: InventorySlot,
  requested: readonly string[],
  mode: InventoryMode,
  targeted = false
): Promise<CommandInventory | null> {
  const generation = inventoryGeneration(slot)
  const current = slot.generation === generation ? slot.current : undefined
  if (mode === 'read' && current && requested.every((cmd) => current.probed.has(cmd))) {
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
      !commands.every((cmd) => active.commands.has(cmd))
    ) {
      const queued = pending.queued ?? {
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

  // The same promise carries all waiters through a queued scan. Caller deadlines never retire it.
  const batch: PendingInventory = {
    active: { commands: new Set(commands), mode, targeted, generation },
    result: Promise.resolve().then(async () => {
      for (;;) {
        const scan = batch.active
        const result = await scanInventory(slot, scan).catch(() => null)
        if (batch.queued) {
          batch.active = batch.queued
          delete batch.queued
        } else if (scan.generation === inventoryGeneration(slot)) {
          delete slot.pending
          if (result) {
            publishInventory(slot, result, scan)
          } else if (slot.distro) {
            delete slot.current
          }
          return result
        }
      }
    })
  }
  slot.pending = batch
  return batch.result
}

const wsl = new Map<string, InventorySlot>()

async function wslInventory(target: WslPreflightTarget): Promise<InventorySlot | undefined> {
  const distro = target.distro?.trim() || (await resolveWslDefaultDistro())
  if (typeof distro !== 'string') {
    return undefined
  }
  const key = distro.toLowerCase()
  const slot = wsl.get(key) ?? { distro }
  wsl.set(key, slot)
  return slot
}

export type TerminalAgentProgram =
  | { kind: 'by-name' | 'full-path'; path: string }
  | { kind: 'unavailable' | 'unknown' }

function qualifyProgram(
  match: AgentPathMatch | undefined,
  shell: AgentStartupShell
): TerminalAgentProgram {
  if (!match?.user) {
    return { kind: 'unavailable' }
  }
  const winner = shell === 'powershell' ? match.unquoted : match.first
  return winner && !isOrcaAgentRuntimePath(winner)
    ? { kind: 'by-name', path: winner }
    : { kind: 'full-path', path: match.user }
}

export async function readLocalTerminalAgentProgram(
  program: string,
  shell: AgentStartupShell,
  refresh = false
): Promise<TerminalAgentProgram> {
  const slot = localInventory()
  const inventory = await readInventory(slot, [program], refresh ? 'revalidate' : 'read')
  return slot === localInventory() && inventory?.probed.has(program)
    ? qualifyProgram(inventory.matches.get(program), shell)
    : { kind: 'unknown' }
}

export async function readWslTerminalAgentProgram(
  target: WslPreflightTarget,
  program: string
): Promise<TerminalAgentProgram> {
  const slot = await wslInventory(target)
  const inventory = slot ? await readInventory(slot, [program], 'read') : null
  if (!inventory?.probed.has(program)) {
    return { kind: 'unknown' }
  }
  return inventory.found.has(program) ? { kind: 'by-name', path: program } : { kind: 'unavailable' }
}

export async function detectAgentCommandsOnHost(
  commands: readonly string[],
  options: {
    connectionId?: string | null
    context?: PreflightRuntimeContext
    outsidePath?: Map<string, string>
    onlyRequested?: boolean
    refresh?: boolean
  } = {}
): Promise<Set<string>> {
  if (options.connectionId) {
    throw new SshHostNotServedError(options.connectionId)
  }
  const wslTarget = getPreflightWslTarget(options.context)
  const targeted = options.onlyRequested ?? false
  const ordinaryMode = targeted ? 'read' : 'detect'
  const refreshMode = targeted ? 'revalidate' : 'refresh'
  const slot = wslTarget ? await wslInventory(wslTarget) : localInventory()
  const inventory = slot
    ? await readInventory(slot, commands, options.refresh ? refreshMode : ordinaryMode, targeted)
    : null
  if (!inventory || (!wslTarget && slot !== localInventory())) {
    throw new Error(`Could not complete ${wslTarget ? 'WSL' : 'local'} agent inventory`)
  }
  if (wslTarget) {
    return new Set(commands.filter((cmd) => inventory.found.has(cmd)))
  }
  const shell = process.platform === 'win32' ? 'powershell' : 'posix'
  return new Set(
    commands.filter((command) => {
      const program = qualifyProgram(inventory.matches.get(command), shell)
      if (program.kind === 'full-path') {
        options.outsidePath?.set(command, program.path)
      }
      return inventory.found.has(command)
    })
  )
}
