import type { MobileRelayPairingProvider } from '../runtime-rpc/runtime-rpc-pairing-types'
import type { DesktopRelayService } from './desktop-relay-service'

type RelayProviderHost = {
  setMobileRelayPairingProvider(provider: MobileRelayPairingProvider | null): void
}

export type DesktopRelayServiceInstallerOptions = {
  runtimeRpc: RelayProviderHost
  // App-owned fetchers must not run ahead of the persisted proxy.
  whenNetworkReady: Promise<unknown>
  // Quit/relaunch fencing: a fenced host never installs a new service.
  isFenced: () => boolean
  // Returns null when this build has no cloud auth; throws on a failed construction.
  create: () => DesktopRelayService | null
  onInstalled: (service: DesktopRelayService) => void
}

export type DesktopRelayServiceInstaller = {
  ensure(): Promise<boolean>
  // Sign-out: refuse installs, including one already waiting, until the next auth change.
  suspend(): void
  authChanged(): Promise<boolean>
}

function pairingProviderFor(service: DesktopRelayService): MobileRelayPairingProvider {
  return {
    createPairingRelay: (relayDeviceId) => service.createPairingRelay(relayDeviceId),
    onDeviceRevokeQueued: (item) => service.onDeviceRevokeQueued(item),
    onDemandStateChanged: () => service.demandStateChanged(),
    getEndpoints: (context, params) => service.getEndpoints(context, params),
    provisionRelay: (context, params) => service.provisionRelay(context, params)
  }
}

// Installs the Relay provider once, on demand: at launch, after a cloud auth
// change, and before an automatic pairing mint. A construction that failed once
// (or ran before the proxy landed) is retried by the next demand, not a restart.
export function createDesktopRelayServiceInstaller(
  options: DesktopRelayServiceInstallerOptions
): DesktopRelayServiceInstaller {
  let installed: DesktopRelayService | null = null
  let pending: Promise<boolean> | null = null
  let suspended = false
  const install = async (): Promise<boolean> => {
    await options.whenNetworkReady
    if (installed || suspended || options.isFenced()) {
      return installed !== null
    }
    try {
      const service = options.create()
      if (!service) {
        return false
      }
      installed = service
      options.onInstalled(service)
      options.runtimeRpc.setMobileRelayPairingProvider(pairingProviderFor(service))
      service.start()
      return true
    } catch (error) {
      console.warn(
        '[relay] Desktop relay startup unavailable:',
        error instanceof Error ? error.message : String(error)
      )
      return false
    }
  }
  const ensure = (): Promise<boolean> => {
    if (installed) {
      return Promise.resolve(true)
    }
    pending ??= install().finally(() => {
      pending = null
    })
    return pending
  }
  return {
    ensure,
    suspend: () => {
      suspended = true
    },
    authChanged: () => {
      suspended = false
      return ensure()
    }
  }
}
