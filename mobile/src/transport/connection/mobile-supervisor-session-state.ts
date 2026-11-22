import * as recoveryPresentation from '../relay/mobile-relay-recovery-presentation'
import * as relayDiagnosticLog from '../../diagnostics/connection/mobile-relay-diagnostic-log'
import type { RelayRecoveryLog } from '../../diagnostics/connection/mobile-relay-recovery-log'
import type { MobileRelayCredentialBundle } from '../../host-credentials/mobile-relay-credential-bundle'
import type { MobileConnectionPath, StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionState } from './connection-state'
import type { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import type { MobileSupervisorCredentialRotation } from './mobile-supervisor-credential-rotation'
import type { MobileSupervisorDirectRoutes } from './mobile-supervisor-direct-routes'
import type { MobileRelayBackgroundGrace } from '../relay/mobile-relay-background-grace'
import type { RelayReconnectController } from '../relay/mobile-relay-reconnect-controller'
import type { MobileRelayDirectGraceTimer } from '../relay/mobile-relay-direct-grace-timer'
import type { DirectReturnProbe } from '../relay/mobile-direct-return-probe'

type SupervisorSessionState = {
  logical: StableLogicalRpcClient
  directGrace: MobileRelayDirectGraceTimer
  directRoutes: MobileSupervisorDirectRoutes
  directProbe: DirectReturnProbe
  backgroundGrace: MobileRelayBackgroundGrace
  relayReconnect: RelayReconnectController
  credentialRotation: MobileSupervisorCredentialRotation
  hysteresis: MobileEndpointHysteresis
  clearPendingReplace: () => void
  bundle: () => MobileRelayCredentialBundle | null
  logRelay: RelayRecoveryLog
}

// Relay recovery, direct path changes and background suspension share this one state observer.
export function subscribeSupervisorSessionState(args: SupervisorSessionState): () => void {
  return args.logical.onStateChange((state: ConnectionState) => {
    const activePath: MobileConnectionPath = args.logical.getActivePath()
    if (state === 'connected') {
      args.directGrace.onConnected()
      if (activePath !== 'relay') {
        args.clearPendingReplace()
        void args.credentialRotation.rotateIfNeeded(args.relayReconnect.resetForDirectConnection())
      }
      args.directProbe.schedule(args.hysteresis.isArrival() ? 0 : undefined)
      return
    }
    if (!args.backgroundGrace.isForeground()) {
      args.backgroundGrace.handleStateFailure()
      return
    }

    // When an alternate direct route is known, preserve the direct grace window before Relay recovery.
    const deferRelay =
      state === 'reconnecting' && activePath !== 'relay' && args.directRoutes.hasRecoveryFallback()
    if (!deferRelay) {
      recoveryPresentation.onActiveFailure(args.logical, args.relayReconnect, state, args.bundle())
      const relayFailure = args.relayReconnect.handleStateFailure(args.logical, state)
      relayDiagnosticLog.logRelayDialFailure(args.logRelay, relayFailure, 'active-session')
    }
    if (activePath !== 'relay') {
      args.directGrace.arm()
    }
  })
}
