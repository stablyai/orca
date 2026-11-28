import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrcaRuntimeRpcServer } from '../rpc/server/runtime-rpc'
import type { PushGatewayClient } from './push-gateway-client'
import type { PushRegisterThrottle } from './push-register-throttle'
import type { ExecutionHostPushCoverage } from './push-burst-slots'

export type DesktopPushServiceOptions = {
  runtime: OrcaRuntimeService
  runtimeRpc: OrcaRuntimeRpcServer
  gatewayUrl: string
  client?: PushGatewayClient
  scheduleRetry?: (run: () => void, delayMs: number) => void
  registerThrottle?: PushRegisterThrottle
  coverage?: ExecutionHostPushCoverage
}
