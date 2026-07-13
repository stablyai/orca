import * as ExpoCrypto from 'expo-crypto'
import { AppState, Platform } from 'react-native'
import { connect, type RpcClient } from './rpc-client'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionLogSink, HostProfile } from './types'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import { directPathForEndpoint } from './mobile-endpoint-supervisor-support'
import { connectMobileRelayRpcSession } from './mobile-relay-rpc-session'
import { resolveMobileRelayEndpoint } from './mobile-relay-resume-director'
import {
  readMobileRelayCredentialBundle,
  writeMobileRelayCredentialBundle
} from './mobile-relay-credential-bundle'
import { saveHost } from './host-store'

export function openHostLogicalClient(host: HostProfile, onLog: ConnectionLogSink): RpcClient {
  // Why: the stable facade owns app-visible RPC/subscription state while the
  // direct socket remains a replaceable first physical generation.
  const logical = createStableLogicalRpcClient(
    connect(host.endpoint, host.deviceToken, host.publicKeyB64, { onLog }),
    directPathForEndpoint(host, host.endpoint)
  )
  if (Platform.OS === 'web' || !host.relay) {
    return logical
  }

  const supervisor = new MobileEndpointSupervisor(logical, host, {
    openDirect: (endpoint) => connect(endpoint, host.deviceToken, host.publicKeyB64, { onLog }),
    openRelay: (relay, credential, confirmReqId) =>
      connectMobileRelayRpcSession({
        relay,
        resumeToken: credential.token,
        resumeCredentialVersion: credential.version,
        resumeConfirmReqId: confirmReqId,
        deviceToken: host.deviceToken,
        desktopPublicKeyB64: host.publicKeyB64
      }),
    resolveRelay: resolveMobileRelayEndpoint,
    readBundle: readMobileRelayCredentialBundle,
    writeBundle: writeMobileRelayCredentialBundle,
    saveHost,
    now: Date.now,
    randomBytes: ExpoCrypto.getRandomBytes,
    setTimer: setTimeout,
    clearTimer: clearTimeout
  })
  supervisor.setForeground(AppState.currentState === 'active')
  const appStateSubscription = AppState.addEventListener('change', (state) => {
    supervisor.setForeground(state === 'active')
  })
  const closeLogical = logical.close
  logical.close = () => {
    appStateSubscription.remove()
    supervisor.stop()
    closeLogical()
  }
  const notifyLogicalForeground = logical.notifyForeground
  logical.notifyForeground = () => {
    supervisor.setForeground(true)
    notifyLogicalForeground()
  }
  void supervisor.start()
  return logical
}
