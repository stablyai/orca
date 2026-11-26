import { resolveLoginShellEnvironment } from '../startup/shell-environment/login-shell-environment'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import {
  probeWslCommandsOnPath,
  type WslPreflightTarget
} from '../ipc/preflight/preflight-wsl-agent-detection'
import { getWslGuestEnvironmentGeneration } from '../wsl/execution/wsl-guest-environment'
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
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

const INVENTORY_TIMEOUT_MS = 10_000
type InventorySlot = {
  pending?: { result: Promise<CommandInventory | null>; fresh: boolean }
  current?: CommandInventory
}
type InventoryMode = 'read' | 'targeted' | 'detect' | 'revalidate' | 'refresh'
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
  readLoginPath: boolean,
  isCurrent: () => boolean
): Promise<CommandInventory | null> {
  const localEnv = buildLocalPreflightEnv()
  const env = localEnv ?? (readLoginPath ? await resolveLoginShellEnvironment() : process.env)
  const pathEnv = env.PATH ?? Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1]
  const matches = new Map<string, AgentPathMatch>()
  const found = await findCommandsOnLocalPath([...probed], {
    env,
    inventory: { isRuntimePath: isOrcaAgentRuntimePath, matches }
  })
  if (!isCurrent()) {
    return null
  }
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

function readInventory(
  slot: InventorySlot,
  requested: readonly string[],
  mode: InventoryMode,
  scan: (probed: ReadonlySet<string>, isCurrent: () => boolean) => Promise<CommandInventory | null>
): Promise<CommandInventory | null> {
  const covers = (result: CommandInventory) => requested.every((cmd) => result.probed.has(cmd))
  if ((mode === 'read' || mode === 'targeted') && slot.current && covers(slot.current)) {
    return Promise.resolve(slot.current)
  }
  const fresh = mode === 'refresh' || mode === 'revalidate'
  if (slot.pending && mode !== 'refresh' && (!fresh || slot.pending.fresh)) {
    return slot.pending.result.then((result) =>
      !result || covers(result) ? result : readInventory(slot, requested, mode, scan)
    )
  }
  const isCurrent = (): boolean => slot.pending === pending
  const result = withTimeout(scan(new Set(requested), isCurrent), INVENTORY_TIMEOUT_MS, null).then(
    (result) => {
      if (!isCurrent()) {
        return null
      }
      delete slot.pending
      if (result) {
        const previous = slot.current
        const notProbed = (command: string) => !result.probed.has(command)
        slot.current =
          mode === 'targeted' && previous
            ? {
                found: new Set([...result.found, ...[...previous.found].filter(notProbed)]),
                matches: new Map([
                  ...result.matches,
                  ...[...previous.matches].filter(([command]) => notProbed(command))
                ]),
                probed: new Set([...previous.probed, ...result.probed])
              }
            : result
      }
      return result
    }
  )
  const pending = { result, fresh }
  slot.pending = pending
  return result
}

type WslInventorySlot = InventorySlot & { retryAfter?: number }
const wsl = new Map<string, { generation: number; slot: WslInventorySlot }>()

function wslInventory(target: WslPreflightTarget): WslInventorySlot {
  const key = target.distro?.toLowerCase() ?? ''
  const generation = getWslGuestEnvironmentGeneration(target.distro)
  const entry = wsl.get(key)
  if (entry?.generation === generation) {
    return entry.slot
  }
  const slot: WslInventorySlot = {}
  wsl.set(key, { slot, generation })
  return slot
}

function readWslInventory(
  slot: WslInventorySlot,
  target: WslPreflightTarget,
  commands: readonly string[],
  mode: InventoryMode
): Promise<CommandInventory | null> {
  if (mode !== 'refresh' && !slot.current && Date.now() < (slot.retryAfter ?? 0)) {
    return Promise.resolve(null)
  }
  return readInventory(slot, commands, mode, async (probed) => {
    const found = await probeWslCommandsOnPath(target, [...probed])
    return found && { found, matches: new Map(), probed }
  }).then((inventory) => {
    if (!inventory && !slot.pending && Date.now() >= (slot.retryAfter ?? 0)) {
      slot.retryAfter = Date.now() + 5_000
    }
    return inventory
  })
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
  const current = !refresh && slot.current?.probed.has(program) ? slot.current : undefined
  const inventory =
    current ??
    (await readInventory(
      slot,
      [...localStockCommands, program],
      refresh ? 'revalidate' : 'read',
      (probed, isCurrent) => scanLocalInventory(probed, true, isCurrent)
    ))
  return slot === localInventory() && inventory?.probed.has(program)
    ? qualifyProgram(inventory.matches.get(program), shell)
    : { kind: 'unknown' }
}

export async function readWslTerminalAgentProgram(
  target: WslPreflightTarget,
  program: string
): Promise<TerminalAgentProgram> {
  const slot = wslInventory(target)
  const inventory = slot.current?.probed.has(program)
    ? slot.current
    : await readWslInventory(slot, target, [...wslStockCommands, program], 'read')
  if (slot !== wslInventory(target) || !inventory) {
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
  const targeted = options.onlyRequested && !options.refresh
  const mode = options.refresh ? 'refresh' : targeted ? 'targeted' : 'detect'
  const wslTarget = getPreflightWslTarget(options.context)
  if (wslTarget) {
    const slot = wslInventory(wslTarget)
    const result = await readWslInventory(
      slot,
      wslTarget,
      targeted ? commands : [...wslStockCommands, ...commands],
      mode === 'detect' ? 'read' : mode
    )
    return new Set(
      slot === wslInventory(wslTarget) ? commands.filter((cmd) => result?.found.has(cmd)) : []
    )
  }
  const slot = localInventory()
  const requested = targeted ? commands : [...localStockCommands, ...commands]
  const inventory = await readInventory(slot, requested, mode, (probed, isCurrent) =>
    scanLocalInventory(probed, false, isCurrent)
  )
  if (!inventory || slot !== localInventory()) {
    throw new Error('Could not complete local agent inventory')
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
