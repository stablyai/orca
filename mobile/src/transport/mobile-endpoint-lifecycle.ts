import * as ExpoCrypto from 'expo-crypto'
import type { ConnectionLogSink, HostProfile } from './types'
import { connect } from './rpc-client'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import { MobileRelayFallbackController } from './mobile-relay-fallback-controller'
import { connectMobileRelayRpcSession } from './mobile-relay-rpc-session'
import { resolveMobileRelayEndpoint } from './mobile-relay-resume-director'
import {
  deleteMobileRelayCredentialBundle,
  readMobileRelayCredentialBundle,
  writeMobileRelayCredentialBundle
} from './mobile-relay-credential-bundle'
import { saveExistingHostRelayUpgrade, updateHostLastGoodEndpoint } from './host-store'
import { upgradeDirectMobileRelay } from './mobile-relay-direct-upgrade'
import { MobileRelayDirectUpgradeController } from './mobile-relay-direct-upgrade-controller'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import { hasAuthoritativeMobileRouteOrder } from './mobile-access-route-order'

type EndpointLifecycle = {
  setForeground(foreground: boolean): void
  stop(): void
}

type EndpointOwner = EndpointLifecycle & {
  start(): Promise<void>
}

export function startMobileEndpointLifecycle(
  logical: StableLogicalRpcClient,
  initialHost: HostProfile,
  onLog: ConnectionLogSink
): EndpointLifecycle {
  let stopped = false
  let foreground = true
  let owner: EndpointOwner

  const startManagedOwner = async (host: HostProfile): Promise<void> => {
    if (stopped) {
      return
    }
    const supervisor = hasAuthoritativeMobileRouteOrder(host)
      ? createSupervisor(logical, host, onLog)
      : createRelayFallbackController(logical, host, onLog)
    owner.stop()
    owner = supervisor
    supervisor.setForeground(foreground)
    await supervisor.start()
  }

  if (hasAuthoritativeMobileRouteOrder(initialHost)) {
    owner = createSupervisor(logical, initialHost, onLog)
    void owner.start()
  } else if (initialHost.relay) {
    // Why: unmarked hosts must retain the released direct/Relay race and
    // authenticated direct probe-back rather than inheriting custom order.
    owner = createRelayFallbackController(logical, initialHost, onLog)
    void owner.start()
  } else {
    owner = new MobileRelayDirectUpgradeController(logical, initialHost, {
      upgrade: (client, host) =>
        upgradeDirectMobileRelay({
          client,
          host,
          dependencies: { randomBytes: ExpoCrypto.getRandomBytes }
        }),
      onUpgraded: ({ host }) => startManagedOwner(host)
    })
    void owner.start()
  }

  return {
    setForeground(next) {
      foreground = next
      owner.setForeground(next)
    },
    stop() {
      stopped = true
      owner.stop()
    }
  }
}

function createRelayFallbackController(
  logical: StableLogicalRpcClient,
  host: HostProfile,
  onLog: ConnectionLogSink
): MobileRelayFallbackController {
  return new MobileRelayFallbackController(logical, host, {
    openDirect: (endpoint) =>
      connect(endpoint, host.deviceToken, host.publicKeyB64, {
        // Why: the fallback probe's timeout and cooldown own retry scheduling.
        onLog,
        autoReconnect: false
      }),
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
    deleteBundle: deleteMobileRelayCredentialBundle,
    saveHost: saveExistingHostRelayUpgrade,
    now: Date.now,
    randomBytes: ExpoCrypto.getRandomBytes,
    setTimer: setTimeout,
    clearTimer: clearTimeout
  })
}

function createSupervisor(
  logical: StableLogicalRpcClient,
  host: HostProfile,
  onLog: ConnectionLogSink
): MobileEndpointSupervisor {
  return new MobileEndpointSupervisor(logical, host, {
    openDirect: (endpoint) =>
      connect(endpoint, host.deviceToken, host.publicKeyB64, {
        onLog,
        endpoints: [endpoint],
        connectTimeoutMs: 2_750,
        autoReconnect: false
      }),
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
    deleteBundle: deleteMobileRelayCredentialBundle,
    saveHost: saveExistingHostRelayUpgrade,
    updateLastGood: updateHostLastGoodEndpoint,
    now: Date.now,
    randomBytes: ExpoCrypto.getRandomBytes,
    setTimer: setTimeout,
    clearTimer: clearTimeout
  })
}
