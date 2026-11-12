import type { RpcClient } from '../rpc/rpc-client-contract'
import type { RelayDialStageSource } from './relay-dial-stage'
import type { DeviceResumeConfirmed } from '../../../../src/shared/remote-runtime/relay/mobile-relay-credential-contract'

export type MobileRelayRpcSession = RpcClient &
  RelayDialStageSource & {
    // Attach reservation is diagnostics only; rotate against getResumeExpiresAt instead.
    getAttachDeadlineAt(): number | null
    getResumeExpiresAt(): number | null
    getResumeConfirmation(): DeviceResumeConfirmed | null
    getFailure(): Error | null
  }
