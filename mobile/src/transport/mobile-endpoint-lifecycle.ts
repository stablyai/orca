import * as ExpoCrypto from 'expo-crypto'
import type { ConnectionLogSink, HostProfile } from './types'
import { connect } from './rpc-client'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import { connectMobileRelayRpcSession } from './mobile-relay-rpc-session'
import { resolveMobileRelayEndpoint } from './mobile-relay-resume-director'
import {
  readMobileRelayCredentialBundle,
  writeMobileRelayCredentialBundle
} from './mobile-relay-credential-bundle'
import { saveHost } from './host-store'
import { upgradeDirectMobileRelay } from './mobile-relay-direct-upgrade'
import { MobileRelayDirectUpgradeController } from './mobile-relay-direct-upgrade-controller'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'

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

  const startSupervisor = async (host: HostProfile): Promise<void> => {
    if (stopped) {
      return
    }
    const supervisor = createSupervisor(logical, host, onLog)
    owner.stop()
    owner = supervisor
    supervisor.setForeground(foreground)
    await supervisor.start()
  }

  if (initialHost.relay) {
    owner = createSupervisor(logical, initialHost, onLog)
    void owner.start()
  } else {
    owner = new MobileRelayDirectUpgradeController(logical, initialHost, {
      upgrade: (client, host) =>
        upgradeDirectMobileRelay({
          client,
          host,
          dependencies: { randomBytes: ExpoCrypto.getRandomBytes }
        }),
      onUpgraded: ({ host }) => startSupervisor(host)
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

function createSupervisor(
  logical: StableLogicalRpcClient,
  host: HostProfile,
  onLog: ConnectionLogSink
): MobileEndpointSupervisor {
  return new MobileEndpointSupervisor(logical, host, {
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
}
