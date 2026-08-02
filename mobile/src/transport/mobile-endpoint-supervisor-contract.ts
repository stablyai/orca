import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { MobileRelayRpcSession } from './mobile-relay-rpc-session'
import type { resolveMobileRelayEndpoint } from './mobile-relay-resume-director'
import type { RpcClient } from './rpc-client'
import type { HostProfile } from './types'

export type MobileEndpointSupervisorDependencies = {
  openDirect: (endpoint: string) => RpcClient
  openRelay: (
    relay: MobileRelayEndpoint,
    credential: { token: string; version: number },
    confirmReqId: string
  ) => MobileRelayRpcSession
  resolveRelay: typeof resolveMobileRelayEndpoint
  readBundle: (hostId: string) => Promise<MobileRelayCredentialBundle | null>
  writeBundle: (bundle: MobileRelayCredentialBundle) => Promise<void>
  saveHost: (host: HostProfile) => Promise<void>
  now: () => number
  randomBytes: (length: number) => Uint8Array
  setTimer: typeof setTimeout
  clearTimer: typeof clearTimeout
}
