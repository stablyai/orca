import { RuntimeRpcMobilePairing } from './runtime-rpc-mobile-pairing'
import { errorMessage } from '../../../shared/error-message'

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

  stop(): Promise<void> {
    if (this.runtimeRpcStop) {
      return this.runtimeRpcStop
    }
    // Fence new exposure and await pending rebind before snapshotting transports, or late wide listeners can leak into cleared arrays (STA-2370).
    this.stopping = true
    const starting = this.runtimeRpcStart
    // A later explicit stop retries debt; a stop joining startup shares its rollback receipt.
    if (!starting) {
      this.runtimeRpcRetirement = null
    }
    const operation = Promise.resolve()
      .then(async () => {
        // Rollback retains its cleanup receipt; a reported start error alone is not a second stop error.
        await starting?.catch(() => {})
        const pendingExposure = this.networkExposurePromise
        if (pendingExposure) {
          await pendingExposure.catch(() => {
            // Failed widening already logged/recovered; await only its transport-array mutations.
          })
        }
        const retirement = this.retireRuntimeRpcTransports()
        const errors = await retirement
        if (errors.length === 1) {
          throw errors[0]
        }
        if (errors.length > 1) {
          throw new AggregateError(errors, errorMessage(errors[0]), { cause: errors[0] })
        }
        if (this.runtimeRpcRetirement === retirement) {
          this.runtimeRpcRetirement = null
        }
      })
      .finally(() => {
        if (this.runtimeRpcStop === operation) {
          this.runtimeRpcStop = null
        }
      })
    this.runtimeRpcStop = operation
    // Shared userData may describe another live runtime; do not erase its metadata.
    return operation
  }
}
