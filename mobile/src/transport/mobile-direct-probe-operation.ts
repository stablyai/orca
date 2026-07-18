import { openAuthenticatedDirectEndpoint } from './mobile-direct-endpoint-probe'
import type { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import type { MobileRelayCredentialRecovery } from './mobile-relay-credential-recovery'
import type { MobileRelayRecoveryTimer } from './mobile-relay-recovery-timer'
import type { RpcClient } from './rpc-client'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { HostProfile } from './types'

export async function runMobileDirectProbe(args: {
  logical: StableLogicalRpcClient
  host: HostProfile
  openDirect: (endpoint: string) => RpcClient
  hysteresis: MobileEndpointHysteresis
  recovery: MobileRelayCredentialRecovery
  recoveryTimer: MobileRelayRecoveryTimer
  leaseTimer: MobileRelayRecoveryTimer
  now: () => number
  isStopped: () => boolean
  isForeground: () => boolean
  clearRelayRotation: () => void
  retryCredentialRepair: () => void
}): Promise<void> {
  let successful: Awaited<ReturnType<typeof openAuthenticatedDirectEndpoint>> = null
  try {
    successful = await openAuthenticatedDirectEndpoint(args.host, args.openDirect, 12_000)
    if (!successful || args.isStopped() || !args.isForeground()) {
      if (!successful) {
        args.hysteresis.recordDirectFailure(args.now())
      }
      return
    }
    if (!args.hysteresis.recordDirectSuccess(args.now())) {
      successful.client.close()
      return
    }
    await args.logical.migrateTo(successful.client, successful.path)
    successful = null
    if (!args.isForeground()) {
      args.logical.suspendActiveSession()
      return
    }
    args.hysteresis.recordMigration(args.now())
    args.recoveryTimer.clear()
    args.leaseTimer.clear()
    args.clearRelayRotation()
    if (args.recovery.needsRepair) {
      const outcome = await args.recovery.reprovision(args.logical)
      if (outcome === 'deferred') {
        args.recoveryTimer.scheduleIfIdle(5000, args.retryCredentialRepair)
      }
    } else {
      await args.recovery.rotateIfNeeded(args.logical)
    }
  } finally {
    successful?.client.close()
  }
}
