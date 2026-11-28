import * as ExpoCrypto from 'expo-crypto'
import type { ConnectionLogSink } from '../../diagnostics/connection/connection-log-types'
import type { ForegroundNudgeReason } from './connection-state'
import type { HostProfile } from '../../host-catalog/host-profile'
import type { MobileRelayEndpoint } from '../../../../src/shared/remote-runtime/relay/mobile-relay-credential-contract'
import { connect } from '../rpc/direct-rpc-connect'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import { connectMobileRelayRpcSession } from '../relay/mobile-relay-rpc-session'
import { resolveMobileRelayEndpoint } from '../relay/mobile-relay-resume-director'
import {
  readMobileRelayCredentialBundle,
  writeMobileRelayCredentialBundle
} from '../../host-credentials/mobile-relay-credential-bundle'
import { setRelayRouting } from '../../host-catalog/host-store'
import { setHostReachesOffLan } from '../../host-descriptors/direct-pairing-installations'
import {
  lastGoodPathWasDirectHere,
  readLocalNetworkFingerprint,
  recordHostGoodPath
} from './host-path-memory'
import { upgradeDirectMobileRelay } from '../relay/mobile-relay-direct-upgrade'
import { directPathForEndpoint } from '../relay/mobile-direct-endpoint-probe'
import { directProbeTimeoutMsForEndpoint } from '../relay/mobile-direct-return-probe'
import { MobileRelayDirectUpgradeController } from '../relay/mobile-relay-direct-upgrade-controller'
import { defaultCancelTimer, defaultScheduleTimer } from '../../platform/timer-scheduler'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import { skipsDirectEndpoint } from './undialable-direct-endpoint'
import {
  createHostDirectEndpointFollower,
  type HostDirectEndpointFollower
} from './host-direct-endpoint-follower'

type EndpointLifecycle = {
  setForeground(foreground: boolean): void
  nudge(reason: ForegroundNudgeReason): void
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
  // The desktop may move its direct address mid-session; the saved endpoint follows once the new one answers.
  const directEndpoints = createHostDirectEndpointFollower({
    client: logical,
    hostId: initialHost.id,
    saved: initialHost,
    openDirect: (endpoint) => openHostDirect(initialHost, endpoint, onLog),
    isForeground: () => foreground,
    now: Date.now
  })
  const unsubscribeDirectEndpoints = logical.onStateChange((state) => {
    if (state === 'connected') {
      directEndpoints.onConnected()
    }
  })

  const startSupervisor = async (relay: MobileRelayEndpoint): Promise<void> => {
    if (stopped) {
      return
    }
    const supervisor = createSupervisor(logical, initialHost, directEndpoints, relay, onLog)
    owner.stop()
    owner = supervisor
    // Upgraded to Relay in place: this host now reaches off its network.
    setHostReachesOffLan(initialHost.id, true)
    supervisor.setForeground(foreground)
    await supervisor.start()
  }

  if (initialHost.relay) {
    owner = createSupervisor(logical, initialHost, directEndpoints, initialHost.relay, onLog)
    void owner.start()
  } else {
    owner = new MobileRelayDirectUpgradeController(logical, initialHost, {
      upgrade: (client, host) =>
        upgradeDirectMobileRelay({
          client,
          host,
          dependencies: { randomBytes: ExpoCrypto.getRandomBytes }
        }),
      onUpgraded: ({ relay }) => startSupervisor(relay)
    })
    void owner.start()
  }

  return {
    setForeground(next) {
      foreground = next
      if (!next) {
        directEndpoints.cancel()
      }
      owner.setForeground(next)
    },
    nudge(reason) {
      // Why: a focus nudge can precede the AppState listener; keep the closure in
      // sync or a later supervisor swap would start with a stale background flag.
      if (reason !== 'network-change') {
        foreground = true
        directEndpoints.refresh()
      }
      owner.nudge(reason)
    },
    stop() {
      stopped = true
      unsubscribeDirectEndpoints()
      directEndpoints.stop()
      owner.stop()
    }
  }
}

function openHostDirect(host: HostProfile, endpoint: string, onLog: ConnectionLogSink) {
  return connect(endpoint, host.deviceToken, host.publicKeyB64, { onLog, hostId: host.id })
}

function createSupervisor(
  logical: StableLogicalRpcClient,
  host: HostProfile,
  directEndpoints: HostDirectEndpointFollower,
  relay: MobileRelayEndpoint,
  onLog: ConnectionLogSink
): MobileEndpointSupervisor {
  return new MobileEndpointSupervisor(logical, host.id, relay, {
    openDirect: () => openHostDirect(host, directEndpoints.directEndpoint(), onLog),
    // Getters: each return probe reads the saved endpoint, which follows a moved desktop.
    get directPath() {
      return directPathForEndpoint(directEndpoints.directEndpoint())
    },
    get directProbeTimeoutMs() {
      return directProbeTimeoutMsForEndpoint(directEndpoints.directEndpoint())
    },
    get directUnavailable() {
      return skipsDirectEndpoint({ ...host, endpoint: directEndpoints.directEndpoint() })
    },
    openRelay: (relay, credential, confirmReqId, onHostCloseReason) =>
      connectMobileRelayRpcSession({
        relay,
        resumeToken: credential.token,
        resumeCredentialVersion: credential.version,
        resumeConfirmReqId: confirmReqId,
        deviceToken: host.deviceToken,
        desktopPublicKeyB64: host.publicKeyB64,
        onHostCloseReason,
        onLog,
        hostId: host.id
      }),
    resolveRelay: resolveMobileRelayEndpoint,
    readBundle: readMobileRelayCredentialBundle,
    writeBundle: writeMobileRelayCredentialBundle,
    setRelayRouting,
    lastGoodPathWasDirectHere,
    recordGoodPath: recordHostGoodPath,
    readLocalNetwork: readLocalNetworkFingerprint,
    onLog,
    now: Date.now,
    randomBytes: ExpoCrypto.getRandomBytes,
    setTimer: defaultScheduleTimer,
    clearTimer: defaultCancelTimer
  })
}
