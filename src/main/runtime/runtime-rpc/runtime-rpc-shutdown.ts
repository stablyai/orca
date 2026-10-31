import { RuntimeRpcMobilePairing } from './runtime-rpc-mobile-pairing'
import { publishHostDescriptor } from '../host-descriptor'

export type RuntimeRpcClientActivity = {
  openConnections: number
  requestsInFlight: number
  lastRequestAt: number
}

export class RuntimeRpcShutdown extends RuntimeRpcMobilePairing {
  /** Why: test-only seam — runs one ownership check instead of waiting out the poll interval. */
  checkRuntimeMetadataOwnership(): Promise<void> {
    return this.metadataOwnershipWatch?.check() ?? Promise.resolve()
  }

  /** What a host's idle exit reads to know whether any client is still using this server. */
  readClientActivity(): RuntimeRpcClientActivity {
    return {
      openConnections: this.mobileSocketWiring?.connectionCount ?? 0,
      requestsInFlight: this.clientRequestsInFlight,
      lastRequestAt: this.lastClientRequestAt
    }
  }

  async stop(): Promise<void> {
    // Fence new exposure and await pending rebind before snapshotting transports, or late wide listeners can leak into cleared arrays (STA-2370).
    this.stopping = true
    const pendingExposure = this.networkExposurePromise
    if (pendingExposure) {
      await pendingExposure.catch(() => {
        // Failed widening already logged/recovered; await only its transport-array mutations.
      })
    }
    const transports = this.activeTransports
    this.activeTransports = []
    this.transports = []
    this.metadataOwnershipWatch?.stop()
    this.metadataOwnershipWatch = null
    if (this.hostDescriptor) {
      publishHostDescriptor(this.runtime.getRuntimeId(), null)
    }
    this.mobileSocketWiring?.dispose()
    this.mobileSocketWiring = null
    this.detachPairedServerRows?.()
    this.detachPairedServerRows = null
    this.detachWebSocketWiring = null
    const stopResults = await Promise.allSettled(
      transports.map(async (transport) => transport.stop())
    )
    // Relay input is fenced before quit; direct auth may still update lastSeen while transports close.
    this.deviceRegistry?.flushPendingLastSeen()
    const failedStop = stopResults.find((result) => result.status === 'rejected')
    if (failedStop?.status === 'rejected') {
      throw failedStop.reason
    }
    // Shared userData may describe another live runtime; do not erase its metadata.
  }
}
