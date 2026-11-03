import process from 'node:process'
import { getAppEnvironment } from '../../shared/app-environment'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { DesktopPushService } from '../runtime/push/desktop-push-service'
import { resolvePushGatewayOrigin } from '../runtime/push/push-gateway-origin'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'

export function startOrcadDesktopPush(
  runtime: OrcaRuntimeService,
  rpc: OrcaRuntimeRpcServer
): void {
  const pushService = DesktopPushService.create({
    runtime,
    runtimeRpc: rpc,
    gatewayUrl: resolvePushGatewayOrigin(process.env, getAppEnvironment().isPackaged())
  })
  pushService?.start()
  getAppEnvironment().onWillQuit(() => pushService?.stop())
}
