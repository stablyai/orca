import { ipcMain } from 'electron'
import { observeWslOrcadHostResponse } from '../../wsl/orcad/wsl-orcad-host-environments'
import { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { isRelayedRuntimeEnvironmentId } from '../../../shared/relayed-runtime-environment'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { manuallyDisconnectedResponse } from './runtime-environment-call-failure'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-manual-disconnect'
import { getRelayedRuntimeEnvironmentStatus } from './runtime-environment-relayed-transport'
import { getRuntimeEnvironmentStatus } from './runtime-environment-status-probe'

export function registerPassiveRuntimeEnvironmentStatusHandler(
  getUserDataPath: () => string
): void {
  ipcMain.handle(
    'runtimeEnvironments:getStatus',
    async (
      _event,
      args: { selector: string; timeoutMs?: number; observeOnly?: true }
    ): Promise<RuntimeRpcResponse<RuntimeStatus>> => {
      if (isRelayedRuntimeEnvironmentId(args.selector)) {
        return getRelayedRuntimeEnvironmentStatus(getUserDataPath(), args.selector, args.timeoutMs)
      }
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
        return manuallyDisconnectedResponse(environment)
      }
      const response = await getRuntimeEnvironmentStatus(
        getUserDataPath(),
        environment.id,
        args.timeoutMs,
        args.observeOnly ? { observeOnly: true } : undefined
      )
      observeWslOrcadHostResponse(environment.id, 'status.get', response)
      return isRuntimeEnvironmentManuallyDisconnected(environment.id)
        ? manuallyDisconnectedResponse(environment)
        : response
    }
  )
}
