import {
  recheckWslAgentPath,
  type WslPreflightTarget
} from '../ipc/preflight/preflight-wsl-agent-detection'
import { hasAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { resolveWslDefaultDistro } from '../wsl/discovery/wsl-default-distro'
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
const wsl = new Map<string, InventorySlot>()

export function configureLocalInventoryShell(readShell: () => string | undefined): void {
  readDefaultShell = readShell
}

export function getLocalInventory(shellOverride?: string): InventorySlot {
  const key = hasAppEnvironment() ? getProfileUserDataPath() : undefined
  const defaultShell =
    process.platform === 'win32' ? undefined : readDefaultShell?.()?.trim() || undefined
  if (!local || key !== profile || local.shellPath !== defaultShell) {
    if (local) {
      invalidateExactLoginShellEnvironments()
    }
    local = { stockCommands: localStockCommands, shellPath: defaultShell }
    profile = key
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
    const oldest = alternateShells.keys().next().value
    if (oldest !== undefined) {
      alternateShells.delete(oldest)
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
  const slot = wsl.get(key) ?? { distro, stockCommands: wslStockCommands }
  wsl.set(key, slot)
  return slot
}

export type TerminalAgentProgram =
  | { kind: 'by-name' | 'full-path'; path: string; canonicalPath?: string }
  | { kind: 'unavailable' | 'unknown' }

export function qualifyProgram(
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

export type TerminalAgentProgramSelection = { program: string; result: TerminalAgentProgram }

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
    await readInventory(
      slot,
      programs,
      retry ? 'refresh' : options.refresh ? 'revalidate' : 'read',
      {
        acceptAnyMatch: true,
        revalidateUnavailable: options.revalidateUnavailable,
        waitForCompletion: true
      }
    ).wait(signal)
    const inventory = currentInventoryPublication(slot, 'complete')?.inventory
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
      if (!match?.first || !canonicalPath || signal.aborted) {
        if (!options.verifyWslHit || retry || signal.aborted) {
          return { program, result: { kind: 'unknown' } }
        }
        rejected = true
        break
      }
      options.onWslDistroSelected?.(slot.distro)
      return {
        program,
        result: options.pinForSetup
          ? { kind: 'full-path', path: match.first, canonicalPath }
          : { kind: 'by-name', path: program }
      }
    }
    if (!rejected) {
      return { program: programs[0], result: { kind: inconclusive ? 'unknown' : 'unavailable' } }
    }
  }
}

export function readPublishedLocalTerminalAgentProgram(
  program: string,
  shell: AgentStartupShell
): TerminalAgentProgram {
  const inventory = currentInventoryPublication(getLocalInventory())?.inventory
  return qualifyProgram(
    inventory?.probed.has(program) ? inventory.matches.get(program) : undefined,
    shell
  )
}
