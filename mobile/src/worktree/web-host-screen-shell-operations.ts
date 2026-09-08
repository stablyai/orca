import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { HostScreenShellOperations } from './host-screen-shell-operations'

export function webHostScreenShellOperations(
  client: MobileWebBridgeClient | null,
  navigateFromHostList: (target: string) => void
): HostScreenShellOperations {
  const requireClient = (): MobileWebBridgeClient => {
    if (!client) {
      throw new Error('Native shell channel unavailable')
    }
    return client
  }

  return {
    ...(client?.native.supports('pagePreferences')
      ? { openSettings: () => navigateFromHostList('/settings') }
      : {}),
    leaveHost() {
      void requireClient().navigationRoute({ destination: 'hostPicker' })
    },
    navigateFromHostList,
    openConnectionDiagnostics() {
      navigateFromHostList('/connection-log')
    },
    async openExternalUrl(url) {
      await requireClient().native.openExternal(url)
    },
    reconnect() {
      return client
        ? client.navigationReconnect().then(() => undefined)
        : Promise.reject(new Error('Native shell channel unavailable'))
    },
    repairPairing() {
      void requireClient().navigationRoute({ destination: 'pairingRepair' })
    },
    removeHost() {
      return client
        ? client.navigationRemoveHost({ confirmation: 'remove-paired-host' }).then(() => undefined)
        : Promise.reject(new Error('Native shell channel unavailable'))
    }
  }
}
