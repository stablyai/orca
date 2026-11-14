import type { BrowserClientHostPlacementPreference } from '../../../../shared/browser/client-hosting/browser-client-host-placement'
import { resolveEnvironment } from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  closePairedRuntimeBrowserClientHostEnvironment,
  startPairedRuntimeBrowserClientHost
} from '../../../browser/client-hosts/lifecycle/paired-runtime-browser-client-host-runtime'
import { prepareBrowserClientHostPlacement } from '../../../browser/client-hosts/lifecycle/browser-client-host-placement-preparation'
import { isRuntimeEnvironmentManuallyDisconnected } from '../connectivity/runtime-environment-manual-disconnect'
import { getRuntimeEnvironmentStatus } from '../status/runtime-environment-status-probe'

export async function prepareRuntimeEnvironmentBrowserPlacement(
  userDataPath: string,
  args: {
    selector: string
    expectedPairingRevision?: number
    preference: BrowserClientHostPlacementPreference
    enabled: boolean
    requireStatus?: boolean
  }
) {
  const initialEnvironment = resolveEnvironment(userDataPath, args.selector)
  requireConnected(initialEnvironment.id)
  const placement = await prepareBrowserClientHostPlacement({
    selector: initialEnvironment.id,
    expectedPairingRevision: args.expectedPairingRevision,
    preference: args.preference,
    enabled: args.enabled,
    resolveEnvironment: (selector) => resolveEnvironment(userDataPath, selector),
    getStatus: async (environmentId) => {
      requireConnected(environmentId)
      const status = await getRuntimeEnvironmentStatus(userDataPath, environmentId, undefined, {
        observeOnly: true
      })
      requireConnected(environmentId)
      if (args.requireStatus && !status.ok) {
        throw new Error(status.error.message)
      }
      return status
    },
    startHost: startPairedRuntimeBrowserClientHost,
    closeHost: closePairedRuntimeBrowserClientHostEnvironment
  })
  if (placement.kind === 'client') {
    try {
      requireConnected(initialEnvironment.id)
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error))
      await closePairedRuntimeBrowserClientHostEnvironment(initialEnvironment.id, reason).catch(
        () => false
      )
      throw reason
    }
  }
  return placement
}

function requireConnected(environmentId: string): void {
  if (isRuntimeEnvironmentManuallyDisconnected(environmentId)) {
    throw new Error('runtime_manually_disconnected')
  }
}
