import { getOrcaPushGatewayUrl } from '../orca-profiles/profile-cloud-auth-config'
import { DesktopPushService } from '../runtime/push/desktop-push-service'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { mainProcessState as state } from './main-process-state'

// Why: deliberately not gated on cloud sign-in like the relay is — the push gateway
// authenticates with the host keypair, so an accountless host registers phones on
// exactly the same path.
export function startDesktopPushService(
  runtime: OrcaRuntimeService,
  runtimeRpc: OrcaRuntimeRpcServer
): void {
  try {
    const pushService = DesktopPushService.create({
      runtime,
      runtimeRpc,
      gatewayUrl: getOrcaPushGatewayUrl()
    })
    pushService?.start()
    state.desktopPushService = pushService
  } catch (error) {
    console.warn(
      '[push] Background push startup unavailable:',
      error instanceof Error ? error.message : String(error)
    )
  }
}
