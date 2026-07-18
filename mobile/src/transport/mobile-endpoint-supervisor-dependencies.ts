import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import type { MobileRelayCredentialRecoveryDependencies } from './mobile-relay-credential-recovery'
import type { MobileRelayRpcSession } from './mobile-relay-rpc-session'
import { resolveMobileRelayEndpoint } from './mobile-relay-resume-director'
import type { RpcClient } from './rpc-client'

export type MobileEndpointSupervisorDependencies = MobileRelayCredentialRecoveryDependencies & {
  openDirect: (endpoint: string) => RpcClient
  openRelay: (
    relay: MobileRelayEndpoint,
    credential: { token: string; version: number },
    confirmReqId: string
  ) => MobileRelayRpcSession
  resolveRelay: typeof resolveMobileRelayEndpoint
  setTimer: typeof setTimeout
  clearTimer: typeof clearTimeout
}
