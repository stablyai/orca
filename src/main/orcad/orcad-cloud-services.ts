import { getAppEnvironment } from '../../shared/app-environment'
import { installConnectorCloud } from '../connector-cloud/connector-cloud-install'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { DesktopPushService } from '../runtime/push/desktop-push-service'
import { resolvePushGatewayOrigin } from '../runtime/push/push-gateway-origin'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'

/** Push and the Orca Cloud connector link; each proves this host with its own key. */
export function startOrcadCloudServices(
  runtime: OrcaRuntimeService,
  rpc: OrcaRuntimeRpcServer,
  userDataPath: string
): void {
  installConnectorCloud(runtime, userDataPath, 'serve')
  const pushService = DesktopPushService.create({
    runtime,
    runtimeRpc: rpc,
    gatewayUrl: resolvePushGatewayOrigin(process.env, getAppEnvironment().isPackaged())
  })
  pushService?.start()
  getAppEnvironment().onWillQuit(() => pushService?.stop())
}
