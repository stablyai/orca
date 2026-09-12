import { RuntimeRpcMobilePairing } from './runtime-rpc-mobile-pairing'

export class RuntimeRpcShutdown extends RuntimeRpcMobilePairing {
  /** Why: test-only seam — runs one ownership check instead of waiting out the poll interval. */
  checkRuntimeMetadataOwnership(): Promise<void> {
    return this.metadataOwnershipWatch?.check() ?? Promise.resolve()
  }

  async stop(): Promise<void> {
    // Why: STA-2370 — refuse new widens, then let any in-flight pairing widen settle into the live
    // transport arrays before snapshotting them, so a racing rebind can't strand a wide 0.0.0.0 listener
    // by writing it back into a cleared array after shutdown (see widenWebSocketBind).
    this.stopping = true
    const pendingExposure = this.networkExposurePromise
    if (pendingExposure) {
      await pendingExposure.catch(() => {
        // Why: a failed widen already recovered/logged; we only need it to finish mutating the arrays.
      })
    }
    const transports = this.activeTransports
    this.activeTransports = []
    this.transports = []
    this.metadataOwnershipWatch?.stop()
    this.metadataOwnershipWatch = null
    this.mobileSocketWiring = null
    this.detachWebSocketWiring = null
    const stopResults = await Promise.allSettled(
      transports.map(async (transport) => transport.stop())
    )
    // Why: before-quit fences relay input; direct auth can still refresh lastSeen while these transports close.
    this.deviceRegistry?.flushPendingLastSeen()
    const failedStop = stopResults.find((result) => result.status === 'rejected')
    // Why: the transport arrays were emptied above regardless of stop outcome, so no listener is
    // advertisable once we get here — clear the port before rethrowing, or `serve stats` keeps
    // reporting a dead port after a failed shutdown.
    this.runtime.setServePort?.(null)
    // Why with the port: no listener means no admission budget, and reporting the caps of a
    // stopped server would read as capacity a caller can still spend.
    this.runtime.setLongPollStatsProvider?.(null)
    if (failedStop?.status === 'rejected') {
      throw failedStop.reason
    }
    // Why: leave the metadata file on shutdown — shared userData may host another live runtime whose bootstrap file we'd erase.
  }
}
