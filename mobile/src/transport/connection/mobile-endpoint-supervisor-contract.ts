import type { MobileRelayEndpoint } from '../../../../src/shared/remote-runtime/relay/mobile-relay-credential-contract'
import type { RelayHostCloseReason } from '../../../../src/shared/relay-host-close-reason'
import type { HostGoodPath } from './host-path-memory'
import type { MobileRelayCredentialBundle } from '../hosts/mobile-relay-credential-bundle'
import type { MobileRelayRpcSession } from '../relay/mobile-relay-rpc-session-contract'
import type { resolveMobileRelayEndpoint } from '../relay/mobile-relay-resume-director'
import type { RpcClient } from '../rpc/rpc-client-contract'
import type { MobileConnectionPath } from './stable-logical-rpc-client'
import type { ScheduleTimer } from '../../platform/timer-scheduler'
import type { ConnectionLogSink } from '../../diagnostics/connection/connection-log-types'

export type MobileEndpointSupervisorDependencies = {
  openDirect: () => RpcClient
  directPath: Exclude<MobileConnectionPath, 'relay'>
  directProbeTimeoutMs: number
  openRelay: (
    relay: MobileRelayEndpoint,
    credential: { token: string; version: number },
    confirmReqId: string,
    onHostCloseReason?: (reason: RelayHostCloseReason) => void
  ) => MobileRelayRpcSession
  resolveRelay: typeof resolveMobileRelayEndpoint
  readBundle: (hostId: string) => Promise<MobileRelayCredentialBundle | null>
  writeBundle: (bundle: MobileRelayCredentialBundle) => Promise<void>
  setRelayRouting: (hostId: string, relay: MobileRelayEndpoint) => Promise<void>
  lastGoodPathWasDirectHere: (hostId: string) => Promise<boolean>
  recordGoodPath: (hostId: string, path: HostGoodPath) => Promise<void>
  readLocalNetwork: () => Promise<string | null>
  now: () => number
  randomBytes: (length: number) => Uint8Array
  setTimer: ScheduleTimer
  clearTimer: typeof clearTimeout
  onLog?: ConnectionLogSink
}
