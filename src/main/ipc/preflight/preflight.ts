import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import type { Store } from '../../persistence/loading-store/store'
import { runPreflightCheck } from '../../preflight/agent-detection'
import { detectRemoteWindowsTerminalCapabilities } from './preflight-remote-windows-terminal-capabilities'
import {
  assertAgentDetectionHostRunning,
  detectAgentsOnHost,
  refreshAgentsOnHost,
  type AgentDetectionHost
} from '../../preflight/workspace-agent-detection'
import type { PreflightStatus } from '../../preflight/agent-detection'
import type { PreflightRuntimeContext } from './preflight-runtime-target'
import type { RemoteWindowsTerminalCapabilities } from './preflight-remote-windows-terminal-capabilities'

import { readZCodeInteractiveCapability } from '../../zcode/interactive-capability'
import { getPreflightWslTarget } from './preflight-runtime-target'
import { runAsWslExecUserAct } from '../../wsl/discovery/wsl-background-exec-gate'
import { deferRefusedPreflight } from './preflight-wsl-refusal-retry'
import { agentCommandOverrideDetectionOptions } from '../../preflight/installed-agent-detection'

type AgentDetectionRequest = PreflightRuntimeContext & { enabledOnly?: boolean }
/** Set by a user act (window focus, a click, opening a picker): it may start its WSL distro. */
type PreflightWake = { wakeWslDistro?: boolean }

function runPreflightAct<T>(
  context: (PreflightRuntimeContext & PreflightWake) | undefined,
  act: () => Promise<T>
): Promise<T> {
  const wslTarget = context?.wakeWslDistro ? getPreflightWslTarget(context) : null
  return deferRefusedPreflight(() =>
    wslTarget ? runAsWslExecUserAct(wslTarget.distro, act) : act()
  )
}

export function registerPreflightHandlers(
  store?: Pick<Store, 'getSettings'>,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  const detectionOptions = (args?: AgentDetectionRequest) => {
    if (!args?.enabledOnly) {
      // Overrides still apply: a configured CLI outside PATH must be listed in every inventory.
      return agentCommandOverrideDetectionOptions(store?.getSettings().agentCmdOverrides)
    }
    if (!store) {
      throw new Error('Agent detection settings unavailable')
    }
    const settings = store.getSettings()
    return {
      disabledTuiAgents: settings.disabledTuiAgents,
      agentCmdOverrides: settings.agentCmdOverrides
    }
  }
  ipc.handle(
    'preflight:check',
    async (
      _event,
      args?: PreflightRuntimeContext & PreflightWake & { force?: boolean }
    ): Promise<PreflightStatus> => {
      return runPreflightAct(args, () => runPreflightCheck(args?.force, args))
    }
  )

  // Mount-time detection must not start a stopped distro; opening an agent picker wakes it.
  ipc.handle(
    'preflight:detectAgents',
    async (_event, args?: AgentDetectionRequest & PreflightWake) =>
      runPreflightAct(args, async () => {
        const host: AgentDetectionHost = { kind: 'local', context: args }
        await assertAgentDetectionHostRunning(host)
        return detectAgentsOnHost(host, detectionOptions(args))
      })
  )

  ipc.handle('preflight:zcodeInteractiveCapability', async () =>
    readZCodeInteractiveCapability(store?.getSettings())
  )

  ipc.handle(
    'preflight:refreshAgents',
    async (_event, args?: AgentDetectionRequest & PreflightWake & { userInitiated?: boolean }) =>
      runPreflightAct(args, async () => {
        const host: AgentDetectionHost = { kind: 'local', context: args }
        await assertAgentDetectionHostRunning(host)
        return refreshAgentsOnHost(host, detectionOptions(args), args?.userInitiated)
      })
  )

  ipc.handle(
    'preflight:detectRemoteAgents',
    async (_event, args: { connectionId: string }): Promise<string[]> =>
      detectAgentsOnHost({ kind: 'ssh', connectionId: args.connectionId })
  )

  ipc.handle(
    'preflight:detectRemoteWindowsTerminalCapabilities',
    async (_event, args: { connectionId: string }): Promise<RemoteWindowsTerminalCapabilities> => {
      return detectRemoteWindowsTerminalCapabilities(args)
    }
  )
}
