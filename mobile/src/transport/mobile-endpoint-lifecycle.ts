import * as ExpoCrypto from 'expo-crypto'
import type { ConnectionLogSink, ForegroundNudgeReason, HostProfile } from './types'
import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import { connect } from './rpc-client'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import { connectMobileRelayRpcSession } from './mobile-relay-rpc-session'
import { resolveMobileRelayEndpoint } from './mobile-relay-resume-director'
import {
  readMobileRelayCredentialBundle,
  writeMobileRelayCredentialBundle
} from './mobile-relay-credential-bundle'
import { saveRefreshedDirectEndpoint } from './host-direct-endpoint-store'
import { setRelayRouting } from './host-store'
import { upgradeDirectMobileRelay } from './mobile-relay-direct-upgrade'
import { directPathForEndpoint } from './mobile-direct-endpoint-probe'
import { MobileRelayDirectUpgradeController } from './mobile-relay-direct-upgrade-controller'
import { defaultCancelTimer, defaultScheduleTimer } from './timer-scheduler'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'

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

  const startSupervisor = async (relay: MobileRelayEndpoint): Promise<void> => {
    if (stopped) {
      return
    }
    const supervisor = createSupervisor(logical, initialHost, relay, onLog)
    owner.stop()
    owner = supervisor
    supervisor.setForeground(foreground)
    await supervisor.start()
  }

  if (initialHost.relay) {
    owner = createSupervisor(logical, initialHost, initialHost.relay, onLog)
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
      owner.setForeground(next)
    },
    nudge(reason) {
      // Why: a focus nudge can precede the AppState listener; keep the closure in
      // sync or a later supervisor swap would start with a stale background flag.
      if (reason !== 'network-change') {
        foreground = true
      }
      owner.nudge(reason)
    },
    stop() {
      stopped = true
      owner.stop()
    }
  }
}

function createSupervisor(
  logical: StableLogicalRpcClient,
  host: HostProfile,
  relay: MobileRelayEndpoint,
  onLog: ConnectionLogSink
): MobileEndpointSupervisor {
  // Why: cafe DHCP / new NIC updates pair-time LAN via pairing.getDirectEndpoints;
  // openDirect must dial the refreshed primary, so host is a mutable closure.
  let currentHost = host
  return new MobileEndpointSupervisor(logical, host.id, relay, {
    openDirect: () =>
      connect(currentHost.endpoint, currentHost.deviceToken, currentHost.publicKeyB64, { onLog }),
    // Why: the dial reads currentHost at call time. A LAN to Tailscale refresh must
    // migrate under that same attempt, not the endpoint captured when this supervisor was created.
    directPath: () => directPathForEndpoint(currentHost.endpoint),
    openRelay: (relay, credential, confirmReqId, onHostCloseReason) =>
      connectMobileRelayRpcSession({
        relay,
        resumeToken: credential.token,
        resumeCredentialVersion: credential.version,
        resumeConfirmReqId: confirmReqId,
        deviceToken: currentHost.deviceToken,
        desktopPublicKeyB64: currentHost.publicKeyB64,
        onHostCloseReason,
        onLog
      }),
    resolveRelay: resolveMobileRelayEndpoint,
    readBundle: readMobileRelayCredentialBundle,
    writeBundle: writeMobileRelayCredentialBundle,
    setRelayRouting,
    getHost: () => currentHost,
    saveHost: async (next) => {
      // Why: a rejected save must leave later dials on the stored endpoint. Assigning
      // first made openDirect use next.endpoint while storage still had the old one.
      await saveRefreshedDirectEndpoint(next)
      currentHost = next
    },
    onLog,
    now: Date.now,
    randomBytes: ExpoCrypto.getRandomBytes,
    setTimer: defaultScheduleTimer,
    clearTimer: defaultCancelTimer
  })
}
