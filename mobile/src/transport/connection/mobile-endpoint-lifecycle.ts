import * as ExpoCrypto from 'expo-crypto'
import type { ConnectionLogSink } from '../../diagnostics/connection/connection-log-types'
import type { ForegroundNudgeReason } from './connection-state'
import type { HostProfile } from '../hosts/host-profile'
import type { MobileRelayEndpoint } from '../../../../src/shared/remote-runtime/relay/mobile-relay-credential-contract'
import { connect } from '../rpc/direct-rpc-connect'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import { connectMobileRelayRpcSession } from '../relay/mobile-relay-rpc-session'
import { resolveMobileRelayEndpoint } from '../relay/mobile-relay-resume-director'
import {
  readMobileRelayCredentialBundle,
  writeMobileRelayCredentialBundle
} from '../hosts/mobile-relay-credential-bundle'
import { setRelayRouting } from '../hosts/host-store'
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
  return new MobileEndpointSupervisor(logical, host.id, relay, {
    openDirect: () => connect(host.endpoint, host.deviceToken, host.publicKeyB64, { onLog }),
    directPath: directPathForEndpoint(host.endpoint),
    directProbeTimeoutMs: directProbeTimeoutMsForEndpoint(host.endpoint),
    openRelay: (relay, credential, confirmReqId, onHostCloseReason) =>
      connectMobileRelayRpcSession({
        relay,
        resumeToken: credential.token,
        resumeCredentialVersion: credential.version,
        resumeConfirmReqId: confirmReqId,
        deviceToken: host.deviceToken,
        desktopPublicKeyB64: host.publicKeyB64,
        onHostCloseReason,
        onLog
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
