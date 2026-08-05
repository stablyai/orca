import type {
  DeviceResumeConfirmed,
  MobileRelayEndpoint
} from '../../../src/shared/mobile-relay-credential-contract'
import type { RpcApplicationResponsiveness } from './rpc-application-responsiveness'
import type { RpcClient } from './rpc-client'

export type MobileRelayRpcSession = RpcClient & {
  // The cell's attach-reservation deadline (~10s). Diagnostics only — never
  // schedule anything from it; rotation keys off getResumeExpiresAt().
  getAttachDeadlineAt(): number | null
  getResumeExpiresAt(): number | null
  getResumeConfirmation(): DeviceResumeConfirmed | null
  getFailure(): Error | null
}

export type MobileRelayRpcSessionOptions = {
  relay: MobileRelayEndpoint
  resumeToken: string
  resumeCredentialVersion: number
  resumeConfirmReqId: string
  deviceToken: string
  desktopPublicKeyB64: string
  requestTimeoutMs?: number
  createSocket?: (url: string) => WebSocket
  applicationResponsiveness?: RpcApplicationResponsiveness
}
