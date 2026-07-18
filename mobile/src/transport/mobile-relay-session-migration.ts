import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import type { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import { encodeBase64Url, toError } from './mobile-endpoint-supervisor-support'
import type { MobileRelayCredentialRecovery } from './mobile-relay-credential-recovery'
import type { MobileRelayAttemptResult } from './mobile-relay-endpoint-retry'
import type { MobileRelayRpcSession } from './mobile-relay-rpc-session'
import type { MobileRelayRecoveryTimer } from './mobile-relay-recovery-timer'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'

const LEASE_ROTATION_MARGIN_MS = 30_000

export async function migrateMobileRelaySession(args: {
  logical: StableLogicalRpcClient
  relay: MobileRelayEndpoint | undefined
  credential: { token: string; version: number }
  recovery: MobileRelayCredentialRecovery
  hysteresis: MobileEndpointHysteresis
  leaseTimer: MobileRelayRecoveryTimer
  openRelay: (
    relay: MobileRelayEndpoint,
    credential: { token: string; version: number },
    confirmReqId: string
  ) => MobileRelayRpcSession
  randomBytes: (length: number) => Uint8Array
  now: () => number
  isForeground: () => boolean
  clearRelayRotation: () => void
  requestRelayRotation: () => void
  scheduleDirectProbe: () => void
}): Promise<MobileRelayAttemptResult> {
  if (!args.relay || !args.recovery.bundle) {
    return { ok: false, error: new Error('relay state missing') }
  }
  const session = args.openRelay(
    args.relay,
    args.credential,
    `confirm-${encodeBase64Url(args.randomBytes(16))}`
  )
  try {
    await args.logical.migrateTo(session, 'relay')
    if (!args.isForeground()) {
      args.logical.suspendActiveSession()
    }
    args.clearRelayRotation()
    args.hysteresis.recordMigration(args.now())
    await args.recovery.recordRelayConnected(
      args.credential.version,
      session.getResumeConfirmation()
    )
    const leaseDeadline = session.getLeaseExpiresAt()
    if (leaseDeadline) {
      args.leaseTimer.scheduleBefore(
        leaseDeadline,
        LEASE_ROTATION_MARGIN_MS,
        args.now(),
        args.requestRelayRotation
      )
    }
    args.scheduleDirectProbe()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: session.getFailure() ?? toError(error) }
  }
}
