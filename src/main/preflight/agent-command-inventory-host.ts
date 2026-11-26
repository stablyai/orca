import type { WslPreflightTarget } from '../ipc/preflight/preflight-wsl-agent-detection'
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
import type { InventorySlot } from './agent-command-inventory'

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
