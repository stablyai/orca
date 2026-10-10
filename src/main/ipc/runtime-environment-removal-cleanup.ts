import { clearBrowserRoutePartitionStorageForEnvironment } from '../browser/browser-route-partition-storage-runtime'
import { retireBrowserRoutePartitionStorageForEnvironment } from '../browser/browser-route-partition-storage-retirement'
import { clearRuntimeEnvironmentCapabilityEvidence } from './runtime-environment-capability-evidence'
import { clearRuntimeEnvironmentManualDisconnect } from './runtime-environment-manual-disconnect'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'

/** Retires a removed server's client-side state; resolves once its transport is invalidated. */
export function retireRemovedRuntimeEnvironment(
  environmentId: string,
  invalidateTransport: (environmentId: string) => Promise<void> | void,
  forgetHostSession?: (hostId: ExecutionHostId) => void
): Promise<void> {
  clearRuntimeEnvironmentCapabilityEvidence(environmentId)
  // Why: listings enumerate session partitions as known hosts, so a kept one names a dead server.
  forgetHostSession?.(toRuntimeExecutionHostId(environmentId))
  clearRuntimeEnvironmentManualDisconnect(environmentId)
  const retiring = Promise.resolve(invalidateTransport(environmentId))
  // Why: removal is an explicit lifecycle decision, so its client-hosted browser storage goes
  // too -- but only once the client host releases its partitions, or every one refuses as live.
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
