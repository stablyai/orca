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
const wsl = new Map<string, InventorySlot>()

export function getLocalInventory(): InventorySlot {
  const key = hasAppEnvironment() ? getProfileUserDataPath() : undefined
  if (!local || key !== profile) {
    local = { stockCommands: localStockCommands }
    profile = key
  }
  return local
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
