import { useEffect } from 'react'
import { AppState } from 'react-native'
import { setBackgroundKeepAlive } from '../transport/background-keep-alive'
import { useRpcClientContext } from '../transport/client-context'
import { loadHostCatalog } from '../transport/host-store'
import type { RpcClientContextValue } from '../transport/rpc-client-context-contract'
import { WorktreeCatalogSnapshotClient } from '../worktree/worktree-catalog-snapshot-client'
import type { LiveAlertsNativeAdapter } from './live-alert-types'
import { LiveAlertsController, startLiveAlertsController } from './live-alerts-controller'
import type { FetchHostRows } from './live-alerts-host-poller'
import { releaseLiveAlertsKeepAlive } from './live-alerts-keepalive-task'
import { liveAlertsNative } from './live-alerts-native'
import {
  loadLiveAlertsPreferences,
  subscribeLiveAlertsPreferences
} from './live-alerts-preferences'

// One snapshot client per host, so `afterSnapshotId` keeps unchanged replies small.
function createCatalogRowFetcher(): FetchHostRows {
  const snapshots = new Map<string, WorktreeCatalogSnapshotClient>()
  return async (client, hostId) => {
    const snapshot = snapshots.get(hostId) ?? new WorktreeCatalogSnapshotClient()
    snapshots.set(hostId, snapshot)
    const result = await snapshot.fetch(client, hostId)
    return result.kind === 'response' ? snapshot.admit(result.pending) : null
  }
}

function startLiveAlertsWatcher(
  native: LiveAlertsNativeAdapter,
  context: RpcClientContextValue
): () => void {
  const names = new Map<string, string>()
  const refreshNames = () => {
    void loadHostCatalog().then(
      (hosts) => {
        names.clear()
        for (const host of hosts) {
          names.set(host.id, host.personalName ?? host.name)
        }
      },
      () => {}
    )
  }
  refreshNames()
  const stopNames = context.subscribeAllHosts(refreshNames)
  let keepAlive = false
  const controller = new LiveAlertsController({
    now: () => Date.now(),
    fetchRows: createCatalogRowFetcher(),
    listClients: () => context.getAllClients(),
    isConnected: (hostId) => context.getState(hostId) === 'connected',
    hostName: (hostId) => names.get(hostId) ?? 'Desktop',
    isForeground: () => AppState.currentState === 'active',
    native,
    setKeepAlive: (active) => {
      setBackgroundKeepAlive(active)
      // The module ends its headless task with the service; settle the JS side of it too.
      if (keepAlive && !active) {
        releaseLiveAlertsKeepAlive()
      }
      keepAlive = active
    }
  })
  const stopController = startLiveAlertsController(controller, {
    scheduleRepeating: (run, intervalMs) => {
      const timer = setInterval(run, intervalMs)
      return () => clearInterval(timer)
    },
    subscribeAppActive: (onActive) => {
      const subscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') {
          onActive()
        }
      })
      return () => subscription.remove()
    },
    subscribeNativeTick: (onTick) => native.subscribeTick(onTick),
    subscribeDismissed: (onDismissed) => native.subscribeDismissed(onDismissed),
    subscribePreferences: subscribeLiveAlertsPreferences,
    loadPreferences: loadLiveAlertsPreferences
  })
  return () => {
    stopController()
    stopNames()
    releaseLiveAlertsKeepAlive()
  }
}

function ActiveLiveAlertsWatcher({ native }: { native: LiveAlertsNativeAdapter }): null {
  const context = useRpcClientContext()
  useEffect(() => startLiveAlertsWatcher(native, context), [native, context])
  return null
}

/**
 * Keeps the Android live agent notification in step with the agents on the hosts the app is
 * connected to. Renders nothing; off Android it doesn't touch the RPC context at all.
 */
export function LiveAlertsWatcher() {
  return liveAlertsNative ? <ActiveLiveAlertsWatcher native={liveAlertsNative} /> : null
}
