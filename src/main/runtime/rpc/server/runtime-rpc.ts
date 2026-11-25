// Why: the single security boundary for the bundled CLI — auth-token enforcement, metadata publication, transport orchestration.
import { RuntimeRpcMobilePairing } from './runtime-rpc-mobile-pairing'
import { publishHostDescriptor } from '../../hosts/platform-probe/host-descriptor'
import type { OrcaRuntimeRpcServerOptions } from './runtime-rpc-pairing-types'
import {
  ORCAD_IDLE_STOP_CLOSE_CODE,
  ORCAD_IDLE_STOP_CLOSE_REASON
} from '../../../../shared/remote-runtime/orcad-lifecycle/orcad-idle-stop-signal'

export type RuntimeRpcClientActivity = {
  openConnections: number
  requestsInFlight: number
  lastRequestAt: number
}

export class OrcaRuntimeRpcServer extends RuntimeRpcMobilePairing {
  constructor(options: OrcaRuntimeRpcServerOptions) {
    super(options)
    // Its share device store owns teammates' devices; the share list and connector reach them here.
    this.runtime.botShareDevices = this
  }

  /** Why: test-only seam — runs one ownership check instead of waiting out the poll interval. */
  checkRuntimeMetadataOwnership(): Promise<void> {
    return this.metadataOwnershipWatch?.check() ?? Promise.resolve()
  }

  /** What a host's idle exit reads to know whether any client is still using this server. */
  readClientActivity(): RuntimeRpcClientActivity {
    return {
      // Passive watchers (keep-awake on a WSL host) must not hold the server and its distro up.
      openConnections: this.mobileSocketWiring?.idleBlockingConnectionCount ?? 0,
      requestsInFlight: this.clientRequestsInFlight,
      lastRequestAt: this.lastClientRequestAt
    }
  }

  /** Refuses every later message undispatched; 4410 promises nothing unanswered ran, else 1012. */
  fenceForIdleStop(): void {
    this.idleStopFenced = true
    const clean = this.clientRequestsInFlight === 0
    this.mobileSocketWiring?.closeAllConnections(
      clean ? ORCAD_IDLE_STOP_CLOSE_CODE : 1012,
      clean ? ORCAD_IDLE_STOP_CLOSE_REASON : 'orcad stopping'
    )
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
    this.detachRelayHostsChanges?.()
    this.detachRelayHostsChanges = null
    this.detachWebSocketWiring = null
    const stopResults = await Promise.allSettled(
      transports.map(async (transport) => transport.stop())
    )
    // Relay input is fenced before quit; direct auth may still update lastSeen while transports close.
    this.deviceRegistry?.flushPendingLastSeen()
    // Direct sockets have closed; relay sockets may still close later, so close() also records who is attached.
    this.clientConnectionLog?.close()
    this.clientConnectionLog = null
    const failedStop = stopResults.find((result) => result.status === 'rejected')
    if (failedStop?.status === 'rejected') {
      throw failedStop.reason
    }
    // Shared userData may describe another live runtime; do not erase its metadata.
  }
}
