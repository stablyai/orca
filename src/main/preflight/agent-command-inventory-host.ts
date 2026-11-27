import {
  recheckWslAgentPath,
  type WslPreflightTarget
} from '../ipc/preflight/preflight-wsl-agent-detection'
import { hasAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { getCachedWslDistros } from '../wsl/discovery/distro-catalog'
import { resolveWslDefaultDistro } from '../wsl/discovery/wsl-default-distro'
import { onWslDiscoveryChanged } from '../wsl/discovery/wsl-discovery-change'
import { onRunningWslDistrosStopped } from '../wsl/discovery/wsl-running-distro-cache'
import { getWslGuestEnvironmentGeneration } from '../wsl/execution/wsl-guest-environment'
import {
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  getTuiAgentDetectionProbeCommands
} from '../../shared/agent-launch/catalog/tui-agent-detection-commands'
import { stockLaunchProgram } from '../../shared/agent-launch/startup/managed-agent-launch-program'
import { TUI_AGENT_CONFIG, isTuiAgent } from '../../shared/agent-launch/catalog/tui-agent-config'
import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../shared/concurrency/abort-signal-reason'
import { invalidateExactLoginShellEnvironments } from '../startup/shell-environment/login-shell-environment'
import {
  currentInventoryPublication,
  readInventory,
  type InventorySlot
} from './agent-command-inventory'
import { retireInventorySlot } from './agent-command-inventory-scan-state'
import { isOrcaAgentRuntimePath } from '../managed-agent-cli/managed-agent-cli-path'
import type { AgentPathMatch } from '../ipc/command-path/command-path-batch'
import type { AgentStartupShell } from '../../shared/agent-launch/startup/tui-agent-startup-shell'

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

let local: InventorySlot | undefined
let profile: string | undefined
let readDefaultShell: (() => string | undefined) | undefined
const alternateShells = new Map<string, InventorySlot>()
const WSL_INVENTORY_LIMIT = 8
const wsl = new Map<string, InventorySlot & { registered: boolean }>()

function retireWslInventory(key: string): void {
  const slot = wsl.get(key)
  if (slot) {
    wsl.delete(key)
    retireInventorySlot(slot)
  }
}

onRunningWslDistrosStopped((stopped) => {
  for (const distro of stopped) {
    retireWslInventory(distro.toLowerCase())
  }
})

onWslDiscoveryChanged(() => {
  const listed = getCachedWslDistros()
  if (!listed || wsl.size === 0) {
    return
  }
  const registered = new Set(listed.map((distro) => distro.toLowerCase()))
  for (const [key, slot] of wsl) {
    if (registered.has(key)) {
      slot.registered = true
    } else if (slot.registered) {
      retireWslInventory(key)
    }
  }
})

export function configureLocalInventoryShell(readShell: () => string | undefined): void {
  readDefaultShell = readShell
}

export function getLocalInventory(shellOverride?: string): InventorySlot {
  const key = hasAppEnvironment() ? getProfileUserDataPath() : undefined
  const defaultShell =
    process.platform === 'win32' ? undefined : readDefaultShell?.()?.trim() || undefined
  if (!local || key !== profile || local.shellPath !== defaultShell) {
    if (local) {
      retireInventorySlot(local)
      invalidateExactLoginShellEnvironments()
    }
    local = { stockCommands: localStockCommands, shellPath: defaultShell }
    profile = key
    for (const slot of alternateShells.values()) {
      retireInventorySlot(slot)
    }
    alternateShells.clear()
  }
  if (process.platform === 'win32' || !shellOverride || shellOverride === defaultShell) {
    return local
  }
  const existing = alternateShells.get(shellOverride)
  if (existing) {
    return existing
  }
  if (alternateShells.size >= 8) {
    const oldest = alternateShells.entries().next().value
    if (oldest) {
      const [shell, slot] = oldest
      retireInventorySlot(slot)
      alternateShells.delete(shell)
    }
  }
  const slot = { stockCommands: localStockCommands, shellPath: shellOverride }
  alternateShells.set(shellOverride, slot)
  return slot
}

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
  const generation = getWslGuestEnvironmentGeneration(distro)
  const existing = wsl.get(key)
  if (existing && !existing.retired && existing.wslGeneration === generation) {
    wsl.delete(key)
    wsl.set(key, existing)
    return existing
  }
  retireWslInventory(key)
  if (wsl.size >= WSL_INVENTORY_LIMIT) {
    const oldest = wsl.keys().next().value
    if (oldest !== undefined) {
      retireWslInventory(oldest)
    }
  }
  const slot = {
    distro,
    stockCommands: wslStockCommands,
    wslGeneration: generation,
    registered: getCachedWslDistros()?.some((name) => name.toLowerCase() === key) ?? false
  }
  wsl.set(key, slot)
  return slot
}

type LocatedTerminalAgentProgram = {
  kind: 'by-name' | 'full-path'
  path: string
  canonicalPath?: string
}
export type TerminalAgentProgram = LocatedTerminalAgentProgram | { kind: 'unavailable' | 'unknown' }

export function qualifyProgram(
  match: AgentPathMatch | undefined,
  shell: AgentStartupShell
): LocatedTerminalAgentProgram | { kind: 'unavailable' } {
  if (!match?.user) {
    return { kind: 'unavailable' }
  }
  const winner = shell === 'powershell' ? match.unquoted : match.first
  return winner && !isOrcaAgentRuntimePath(winner)
    ? { kind: 'by-name', path: winner }
    : { kind: 'full-path', path: match.user }
}

export type TerminalAgentProgramSelection = {
  program: string
  result: TerminalAgentProgram
  cached?: true
  runtimeOnly?: true
}

export async function selectWslTerminalAgentProgram(
  target: WslPreflightTarget,
  programs: readonly [string, ...string[]],
  options: {
    refresh?: boolean
    pinForSetup?: boolean
    verifyWslHit?: boolean
    revalidateUnavailable?: boolean
    onWslDistroSelected?: (distro: string) => void
  },
  signal: AbortSignal
): Promise<TerminalAgentProgramSelection> {
  const slot = await wslInventory(target, signal)
  if (!slot?.distro) {
    return { program: programs[0], result: { kind: 'unknown' } }
  }
  for (let retry = false; ; retry = true) {
    const publication = await readInventory(
      slot,
      programs,
      retry ? 'refresh' : options.refresh ? 'revalidate' : 'read',
      {
        acceptAnyMatch: true,
        revalidateUnavailable: options.revalidateUnavailable,
        waitForCompletion: true
      }
    ).wait(signal)
    const completed = currentInventoryPublication(slot, 'complete')
    const inventory =
      publication && publication.sequence === completed?.sequence
        ? publication.inventory
        : completed?.inventory
    if (!inventory) {
      return { program: programs[0], result: { kind: 'unknown' } }
    }
    let inconclusive = false
    let rejected = false
    for (const program of programs) {
      if (!inventory.probed.has(program)) {
        inconclusive = true
        continue
      }
      if (!inventory.found.has(program)) {
        continue
      }
      const match = inventory.matches.get(program)
      const canonicalPath =
        options.verifyWslHit && match?.first
          ? await recheckWslAgentPath(slot.distro, match.first, signal)
          : match?.user
      if (slot.retired) {
        return { program, result: { kind: 'unknown' } }
      }
      if (!match?.first || !canonicalPath || signal.aborted) {
        if (!options.verifyWslHit || retry || signal.aborted) {
          return { program, result: { kind: 'unknown' } }
        }
        rejected = true
        break
      }
      options.onWslDistroSelected?.(slot.distro)
      // The guest scan skips Windows mounts, so it cannot prove by-name precedence.
      return {
        program,
        result: options.pinForSetup
          ? { kind: 'full-path', path: match.first, canonicalPath }
          : options.verifyWslHit
            ? { kind: 'full-path', path: match.first }
            : { kind: 'by-name', path: program }
      }
    }
    if (!rejected) {
      return { program: programs[0], result: { kind: inconclusive ? 'unknown' : 'unavailable' } }
    }
  }
}
