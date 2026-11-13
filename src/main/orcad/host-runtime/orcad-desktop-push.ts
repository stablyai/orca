import process from 'node:process'
import { getAppEnvironment } from '../../../shared/app-environment'
import { DesktopPushService } from '../../runtime/push/desktop-push-service'
import { resolvePushGatewayOrigin } from '../../runtime/push/push-gateway-origin'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { OrcaRuntimeRpcServer } from '../../runtime/rpc/server/runtime-rpc'

/** Phones register push tokens with this host; the service stops when orcad quits. */
export function startOrcadDesktopPushService(
  runtime: OrcaRuntimeService,
  runtimeRpc: OrcaRuntimeRpcServer
): void {
  const pushService = DesktopPushService.create({
    runtime,
    runtimeRpc,
    gatewayUrl: resolvePushGatewayOrigin(process.env, getAppEnvironment().isPackaged())
  })
  pushService?.start()
  getAppEnvironment().onWillQuit(() => pushService?.stop())
}
