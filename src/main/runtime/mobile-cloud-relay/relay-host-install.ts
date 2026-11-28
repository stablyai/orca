// The cloud relay on any host: the desktop app, Electron `orca serve` and orcad.
import { getOrcaCloudAuthConfig } from '../../orca-profiles/cloud-auth/profile-cloud-auth-config'
import { onTeamFeatureBlockChanged } from '../../orca-profiles/cloud-auth/active-team-capabilities'
import { ORCA_CLOUD_TEAM_POLICY_FLAGS } from '../../../shared/orca-profiles/orca-cloud-team-policy'
import type { OrcaRuntimeRpcServer } from '../rpc/server/runtime-rpc'
import { RELAY_HOST_CLOSE_REASON } from '../../../shared/remote-runtime/relay/relay-host-close-reason'
import type { MobileRelayStatusPublisher } from '../../../shared/remote-runtime/relay/mobile-relay-status'
import type { DesktopRelayService } from './desktop-relay-service'
import { createDesktopRelayServiceInstaller } from './desktop-relay-service-installer'

export type RelayHostOptions = {
  runtimeRpc: OrcaRuntimeRpcServer
  /** This host's own data folder, so the relay serves its own Orca account and keys. */
  userDataPath: string
  appVersion: string
  // App-owned fetchers must not run ahead of the persisted proxy.
  whenNetworkReady: Promise<unknown>
  /** Quitting or relaunching: nothing new starts. */
  isFenced: () => boolean
  onStatus: MobileRelayStatusPublisher
}

export type RelayHost = {
  /** A sign-in or account switch: retry a refused install and re-read who the relay serves. */
  accountChanged: () => void
  /** Before revoking: refuse installs until the next sign-in and tell paired phones it signed out. */
  signOutStarted: () => void
  /** Quit or relaunch: close now without looking like a sign-out. */
  fence: () => void
  /** Sleep can expire the token with no retry timer; wake is the recovery opportunity. */
  ensureLive: () => void
  /** Stops timers, for a host that stops without exiting. */
  stop: () => void
}

/** Starts once RPC has its pairing identity; installs lazily again on pairing demand or sign-in. */
export function installRelayHost(options: RelayHostOptions): RelayHost {
  let service: DesktopRelayService | null = null
  let signingOut = false
  const installer = createDesktopRelayServiceInstaller({
    runtimeRpc: options.runtimeRpc,
    whenNetworkReady: options.whenNetworkReady,
    isFenced: options.isFenced,
    create: async () => {
      const cloudAuth = getOrcaCloudAuthConfig()
      if (!cloudAuth.configured) {
        return null
      }
      const { DesktopRelayService } = await import('./desktop-relay-service')
      return new DesktopRelayService({
        authConfig: cloudAuth.config,
        userDataPath: options.userDataPath,
        appVersion: options.appVersion,
        runtimeRpc: options.runtimeRpc,
        onStatus: options.onStatus
      })
    },
    onInstalled: (installed) => {
      service = installed
    }
  })
  const stopWatchingPolicy = onTeamFeatureBlockChanged(
    ORCA_CLOUD_TEAM_POLICY_FLAGS.mobileRelay,
    (blocked) => {
      if (signingOut || options.isFenced()) {
        return
      }
      if (blocked) {
        service?.fenceAndCloseNow()
      }
      service?.authMutated()
    }
  )
  options.runtimeRpc.setMobileRelayPairingProviderInstaller(() => installer.ensure())
  void installer.ensure()
  return {
    accountChanged: () => {
      signingOut = false
      void installer.authChanged()
      service?.authMutated()
    },
    signOutStarted: () => {
      signingOut = true
      installer.suspend()
      service?.fenceAndCloseNow(RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
    },
    fence: () => service?.fenceAndCloseNow(),
    ensureLive: () => service?.ensureLive(),
    stop: () => {
      stopWatchingPolicy()
      options.runtimeRpc.setMobileRelayPairingProviderInstaller(null)
      options.runtimeRpc.setMobileRelayPairingProvider(null)
      service?.stop()
    }
  }
}
