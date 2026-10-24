import { clearBrowserRoutePartitionStorageForEnvironment } from '../../browser/browser-route-partition-storage-runtime'
import { retireBrowserRoutePartitionStorageForEnvironment } from '../../browser/browser-route-partition-storage-retirement'
import { clearRuntimeEnvironmentCapabilityEvidence } from './runtime-environment-capability-evidence'
import { clearRuntimeEnvironmentManualDisconnect } from './runtime-environment-manual-disconnect'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import {
  forgetRemoteLayoutSnapshot,
  type RemoteLayoutSnapshotStore
} from '../../remote-layout-snapshot/remote-layout-snapshot-recorder'

export type RemovedServerStore = RemoteLayoutSnapshotStore & {
  removeWorkspaceSessionHost: (hostId: ExecutionHostId) => void
}

/** Retires a removed server's client-side state; resolves once its transport is invalidated. */
export function retireRemovedRuntimeEnvironment(
  environmentId: string,
  invalidateTransport: (environmentId: string) => Promise<void> | void,
  store: RemovedServerStore
): Promise<void> {
  clearRuntimeEnvironmentCapabilityEvidence(environmentId)
  // Retained session partitions make listings advertise the removed server as a known host.
  store.removeWorkspaceSessionHost(toRuntimeExecutionHostId(environmentId))
  forgetRemoteLayoutSnapshot(store, environmentId)
  clearRuntimeEnvironmentManualDisconnect(environmentId)
  const retiring = Promise.resolve(invalidateTransport(environmentId))
  // Explicit removal retires browser storage after client hosts release their live partitions.
  void retireBrowserRoutePartitionStorageForEnvironment({
    environmentId,
    whenClientHostClosed: retiring,
    clearStorage: clearBrowserRoutePartitionStorageForEnvironment,
    onError: (error) => {
      console.warn('[runtime-environments] browser partition storage clear failed:', error)
    }
  }).catch((error) => {
    console.warn('[runtime-environments] browser partition storage clear failed:', error)
  })
  return retiring
}
