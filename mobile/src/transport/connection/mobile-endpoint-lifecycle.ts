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
import {
  lastGoodPathWasDirectHere,
  readLocalNetworkFingerprint,
  recordHostGoodPath
} from './host-path-memory'
import { upgradeDirectMobileRelay } from '../relay/mobile-relay-direct-upgrade'
import { directPathForEndpoint } from '../relay/mobile-direct-endpoint-probe'
import { isSameDirectEndpoint } from './direct-endpoint-comparison'
import { directProbeTimeoutMsForEndpoint } from '../relay/mobile-direct-return-probe'
import { MobileRelayDirectUpgradeController } from '../relay/mobile-relay-direct-upgrade-controller'
import { MobileDirectTailnetFallback } from './mobile-direct-tailnet-fallback'
import { defaultCancelTimer, defaultScheduleTimer } from '../../platform/timer-scheduler'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import { skipsDirectEndpoint } from './undialable-direct-endpoint'

type EndpointLifecycle = {
  setForeground(foreground: boolean): void
  nudge(reason: ForegroundNudgeReason): void
  stop(): void
  learnTailnetEndpoint(endpoint: string): void
  learnLanEndpoint(endpoint: string): void
}

type EndpointOwner = Pick<EndpointLifecycle, 'setForeground' | 'nudge' | 'stop'> & {
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
  let tailnetFallback: MobileDirectTailnetFallback | null = null
  let currentTailnetEndpoint: string | undefined
  let currentLanEndpoint: string | undefined
  let relayActive = initialHost.relay !== undefined
  let relaySupervisor: MobileEndpointSupervisor | null = null
  const primaryPath = directPathForEndpoint(initialHost.endpoint)

  const refreshDirectFallback = (): void => {
    if (relayActive) {
      return
    }
    tailnetFallback?.stop()
    const backup = primaryPath === 'lan' ? currentTailnetEndpoint : currentLanEndpoint
    if (!backup) {
      tailnetFallback = null
      return
    }
    tailnetFallback = new MobileDirectTailnetFallback(
      logical,
      (path) =>
        connect(
          path === 'lan'
            ? (currentLanEndpoint ?? (primaryPath === 'lan' ? initialHost.endpoint : backup))
            : (currentTailnetEndpoint ??
                (primaryPath === 'tailscale' ? initialHost.endpoint : backup)),
          initialHost.deviceToken,
          initialHost.publicKeyB64,
          { onLog }
        ),
      true
    )
    tailnetFallback.start()
    tailnetFallback.setForeground(foreground)
  }

  const installTailnetFallback = (endpoint: string): void => {
    if (stopped || primaryPath === 'tailscale' || currentTailnetEndpoint === endpoint) {
      return
    }
    currentTailnetEndpoint = endpoint
    if (relaySupervisor) {
      relaySupervisor.learnEndpoint('tailscale', endpoint)
    } else {
      refreshDirectFallback()
    }
  }

  const installLanFallback = (endpoint: string): void => {
    if (
      stopped ||
      isSameDirectEndpoint(endpoint, initialHost.endpoint) ||
      currentLanEndpoint === endpoint
    ) {
      return
    }
    currentLanEndpoint = endpoint
    if (relaySupervisor) {
      relaySupervisor.learnEndpoint('lan', endpoint)
    } else {
      refreshDirectFallback()
    }
  }

  const startSupervisor = async (relay: MobileRelayEndpoint): Promise<void> => {
    if (stopped) {
      return
    }
    const supervisor = createSupervisor(logical, initialHost, relay, onLog)
    relayActive = true
    tailnetFallback?.stop()
    tailnetFallback = null
    owner.stop()
    owner = supervisor
    relaySupervisor = supervisor
    supervisor.setForeground(foreground)
    if (currentTailnetEndpoint) {
      supervisor.learnEndpoint('tailscale', currentTailnetEndpoint)
    }
    if (currentLanEndpoint) {
      supervisor.learnEndpoint('lan', currentLanEndpoint)
    }
    await supervisor.start()
  }

  if (initialHost.relay) {
    const supervisor = createSupervisor(logical, initialHost, initialHost.relay, onLog)
    owner = supervisor
    relaySupervisor = supervisor
    if (initialHost.tailnetEndpoint) {
      installTailnetFallback(initialHost.tailnetEndpoint)
    }
    if (initialHost.lanEndpoint) {
      installLanFallback(initialHost.lanEndpoint)
    }
    void owner.start()
  } else {
    if (initialHost.tailnetEndpoint) {
      installTailnetFallback(initialHost.tailnetEndpoint)
    }
    if (initialHost.lanEndpoint) {
      installLanFallback(initialHost.lanEndpoint)
    }
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
      tailnetFallback?.setForeground(next)
    },
    nudge(reason) {
      // Why: a focus nudge can precede the AppState listener; keep the closure in
      // sync or a later supervisor swap would start with a stale background flag.
      if (reason !== 'network-change' && !foreground) {
        foreground = true
        tailnetFallback?.setForeground(true)
      }
      owner.nudge(reason)
      tailnetFallback?.nudge(reason)
    },
    stop() {
      stopped = true
      owner.stop()
      tailnetFallback?.stop()
    },
    learnTailnetEndpoint: installTailnetFallback,
    learnLanEndpoint: installLanFallback
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
    openTailnetDirect: (endpoint) =>
      connect(endpoint, host.deviceToken, host.publicKeyB64, { onLog }),
    openLanDirect: (endpoint) => connect(endpoint, host.deviceToken, host.publicKeyB64, { onLog }),
    directPath: directPathForEndpoint(host.endpoint),
    directProbeTimeoutMs: directProbeTimeoutMsForEndpoint(host.endpoint),
    directUnavailable: skipsDirectEndpoint(host),
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
