import * as ExpoCrypto from 'expo-crypto'
import type { ConnectionLogSink, ForegroundNudgeReason, HostProfile } from './types'
import { connect } from './rpc-client'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import { connectMobileRelayRpcSession } from './mobile-relay-rpc-session'
import { resolveMobileRelayEndpoint } from './mobile-relay-resume-director'
import {
  readMobileRelayCredentialBundle,
  writeMobileRelayCredentialBundle
} from './mobile-relay-credential-bundle'
import {
  saveExistingHostRelayRouting,
  writeExistingHostRelayCredentialBundle
} from './existing-host-relay-routing'
import {
  beginHostEndpointPublicationLifecycle,
  getHostEndpointPublicationLifecycle,
  type HostEndpointPublicationLifecycle
} from './host-profile-publication'
import { upgradeDirectMobileRelay } from './mobile-relay-direct-upgrade'
import { retireMobileRelayDirectUpgradeJournalForRelayHost } from './mobile-relay-direct-upgrade-journal'
import { MobileRelayDirectUpgradeController } from './mobile-relay-direct-upgrade-controller'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import { RpcApplicationResponsiveness } from './rpc-application-responsiveness'

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
  onLog: ConnectionLogSink,
  onHostUpdated: (host: HostProfile, sourceRevision?: number) => void = () => {},
  applicationResponsiveness = new RpcApplicationResponsiveness()
): EndpointLifecycle {
  let stopped = false
  let foreground = true
  let owner: EndpointOwner
  let publishedSourceRevision: number | undefined
  const endpointLifecycle = beginHostEndpointPublicationLifecycle(initialHost.id)
  const publishHostUpdate = (host: HostProfile): void => {
    if (!stopped) {
      onHostUpdated(host, publishedSourceRevision)
    }
  }
  const saveHost = async (host: HostProfile, beforePublish?: () => Promise<void>) => {
    publishedSourceRevision = await saveExistingHostRelayRouting(
      host,
      beforePublish,
      endpointLifecycle
    )
    return publishedSourceRevision
  }

  const startSupervisor = async (host: HostProfile): Promise<void> => {
    if (stopped) {
      return
    }
    const supervisor = createSupervisor(
      logical,
      host,
      onLog,
      publishHostUpdate,
      endpointLifecycle,
      saveHost,
      applicationResponsiveness
    )
    owner.stop()
    owner = supervisor
    supervisor.setForeground(foreground)
    await supervisor.start()
  }

  if (initialHost.relay) {
    // Why: relay publication supersedes any committed journal retained by the retired direct owner.
    void retireMobileRelayDirectUpgradeJournalForRelayHost(initialHost.id, () => {
      const current = getHostEndpointPublicationLifecycle(initialHost.id)
      return (
        !stopped &&
        current.generation === endpointLifecycle.generation &&
        current.endpointRevision === endpointLifecycle.endpointRevision
      )
    }).catch(() => {})
    owner = createSupervisor(
      logical,
      initialHost,
      onLog,
      publishHostUpdate,
      endpointLifecycle,
      saveHost,
      applicationResponsiveness
    )
    void owner.start()
  } else {
    owner = new MobileRelayDirectUpgradeController(logical, initialHost, {
      upgrade: (client, host) =>
        upgradeDirectMobileRelay({
          client,
          host,
          dependencies: {
            randomBytes: ExpoCrypto.getRandomBytes,
            saveHost
          }
        }),
      onUpgraded: async ({ host }) => {
        publishHostUpdate(host)
        await startSupervisor(host)
      }
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
  onLog: ConnectionLogSink,
  onHostUpdated: (host: HostProfile) => void,
  endpointLifecycle: HostEndpointPublicationLifecycle,
  saveHost: (host: HostProfile, beforePublish?: () => Promise<void>) => Promise<number>,
  applicationResponsiveness: RpcApplicationResponsiveness
): MobileEndpointSupervisor {
  return new MobileEndpointSupervisor(logical, host, {
    openDirect: (endpoint) =>
      connect(endpoint, host.deviceToken, host.publicKeyB64, {
        onLog,
        applicationResponsiveness
      }),
    openRelay: (relay, credential, confirmReqId) =>
      connectMobileRelayRpcSession({
        relay,
        resumeToken: credential.token,
        resumeCredentialVersion: credential.version,
        resumeConfirmReqId: confirmReqId,
        deviceToken: host.deviceToken,
        desktopPublicKeyB64: host.publicKeyB64,
        applicationResponsiveness
      }),
    resolveRelay: resolveMobileRelayEndpoint,
    readBundle: readMobileRelayCredentialBundle,
    writeBundle: (bundle) =>
      writeExistingHostRelayCredentialBundle(
        host,
        bundle,
        writeMobileRelayCredentialBundle,
        endpointLifecycle
      ),
    saveHost,
    onHostUpdated,
    onLog,
    now: Date.now,
    randomBytes: ExpoCrypto.getRandomBytes,
    setTimer: setTimeout,
    clearTimer: clearTimeout
  })
}
