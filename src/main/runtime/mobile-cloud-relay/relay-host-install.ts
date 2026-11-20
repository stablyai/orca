// The cloud relay on any host: the desktop app, Electron `orca serve` and orcad.
import { getOrcaCloudAuthConfig } from '../../orca-profiles/cloud-auth/profile-cloud-auth-config'
import type { OrcaRuntimeRpcServer } from '../rpc/server/runtime-rpc'
import { RELAY_HOST_CLOSE_REASON } from '../../../shared/remote-runtime/relay/relay-host-close-reason'
import type { MobileRelayStatusPublisher } from '../../../shared/remote-runtime/relay/mobile-relay-status'
import { DesktopRelayService } from './desktop-relay-service'
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
  const installer = createDesktopRelayServiceInstaller({
    runtimeRpc: options.runtimeRpc,
    whenNetworkReady: options.whenNetworkReady,
    isFenced: options.isFenced,
    create: () => {
      const cloudAuth = getOrcaCloudAuthConfig()
      return cloudAuth.configured
        ? new DesktopRelayService({
            authConfig: cloudAuth.config,
            userDataPath: options.userDataPath,
            appVersion: options.appVersion,
            runtimeRpc: options.runtimeRpc,
            onStatus: options.onStatus
          })
        : null
    },
    onInstalled: (installed) => {
      service = installed
    }
  })
  options.runtimeRpc.setMobileRelayPairingProviderInstaller(() => installer.ensure())
  void installer.ensure()
  return {
    accountChanged: () => {
      void installer.authChanged()
      service?.authMutated()
    },
    signOutStarted: () => {
      installer.suspend()
      service?.fenceAndCloseNow(RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
    },
    fence: () => service?.fenceAndCloseNow(),
    ensureLive: () => service?.ensureLive(),
    stop: () => {
      options.runtimeRpc.setMobileRelayPairingProviderInstaller(null)
      options.runtimeRpc.setMobileRelayPairingProvider(null)
      installer.stop()
      service = null
    }
  }
}
