import { BrowserNetworkTunnelClient } from '../browser/browser-network-tunnel-client'
import type { PairingOffer } from '../../shared/pairing'
import { PortForwardEvent } from '../../shared/port-forward-protocol'
import { PORT_FORWARD_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import {
  subscribeRemoteRuntimeRequest,
  type RemoteRuntimeSubscription,
  type RemoteRuntimeSubscriptionOptions
} from '../../shared/remote-runtime-client'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'

// Why these caps: a forward carries whatever the dev server streams, so an unbounded
// outbound queue would let one slow socket grow the client's heap without limit. The
// numbers mirror the browser tunnel, which carries the same shape of traffic.
const PORT_FORWARD_WS_SOFT_CAP_BYTES = 1024 * 1024
const PORT_FORWARD_WS_MAX_QUEUED_BYTES = 7 * 1024 * 1024
const DEFAULT_ATTACH_TIMEOUT_MS = 15_000

type PortForwardTransportOptions = {
  pairing: PairingOffer
  timeoutMs?: number
  subscription?: RemoteRuntimeSubscriptionOptions
  /** The tunnel died after it was established; every forwarded socket is now dead. */
  onLost?: (error: Error) => void
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * One `network.portForward` subscription and the tunnel client riding it. Separate from
 * the browser tunnel's transport because that one is scoped by a browser-host lease and
 * carries execution-host routing; a forward needs neither.
 */
export class PortForwardTransport {
  private readonly options: PortForwardTransportOptions
  private subscription: RemoteRuntimeSubscription | null = null
  private tunnelValue: BrowserNetworkTunnelClient | null = null
  private startPromise: Promise<BrowserNetworkTunnelClient> | null = null
  /** Settles an attach that is still waiting for readiness when the transport closes. */
  private rejectPendingReady: ((error: Error) => void) | null = null
  private closed = false

  constructor(options: PortForwardTransportOptions) {
    this.options = options
  }

  get tunnel(): BrowserNetworkTunnelClient | null {
    return this.tunnelValue
  }

  start(): Promise<BrowserNetworkTunnelClient> {
    if (this.closed) {
      return Promise.reject(new Error('port_forward_transport_closed'))
    }
    this.startPromise ??= this.attach()
    return this.startPromise
  }

  private async attach(): Promise<BrowserNetworkTunnelClient> {
    let resolveReady = (): void => {}
    let rejectReady = (_error: Error): void => {}
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    void ready.catch(() => undefined)
    this.rejectPendingReady = rejectReady

    let readyTimeout: ReturnType<typeof setTimeout> | null = null
    try {
      const subscription = await subscribeRemoteRuntimeRequest(
        this.options.pairing,
        'network.portForward',
        {},
        this.options.timeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS,
        {
          onResponse: (response) => {
            if (this.closed) {
              return
            }
            if (!response.ok) {
              this.fail(
                new RemoteRuntimeClientError(response.error.code, response.error.message),
                rejectReady
              )
              return
            }
            const parsed = PortForwardEvent.safeParse(response.result)
            if (!parsed.success) {
              this.fail(new Error('port_forward_event_invalid'), rejectReady)
              return
            }
            if (parsed.data.type === 'ready') {
              this.acceptReady(parsed.data.tunnelGeneration, resolveReady, rejectReady)
              return
            }
            this.fail(new Error('port_forward_closed_by_runtime'), rejectReady)
          },
          onBinary: (bytes) => {
            if (this.closed) {
              return
            }
            if (!this.tunnelValue) {
              // Why fail rather than buffer: frames before readiness carry a generation
              // this client never agreed to, so replaying them would cross tunnels.
              this.fail(new Error('port_forward_binary_before_ready'), rejectReady)
              return
            }
            this.tunnelValue.handleBinary(bytes)
          },
          onError: (error) => this.fail(asError(error), rejectReady),
          onClose: () => this.fail(new Error('port_forward_transport_closed'), rejectReady)
        },
        {
          ...this.options.subscription,
          perMessageDeflate: false,
          outboundQueue: {
            softCapBytes: PORT_FORWARD_WS_SOFT_CAP_BYTES,
            maxQueuedBytes: PORT_FORWARD_WS_MAX_QUEUED_BYTES,
            maxQueuedFrames: 2_048,
            maxDrainFramesPerTurn: 4
          },
          clientCapabilities: [
            ...(this.options.subscription?.clientCapabilities ?? []),
            PORT_FORWARD_RUNTIME_CAPABILITY
          ]
        }
      )
      if (this.closed) {
        subscription.close()
        throw new Error('port_forward_transport_closed')
      }
      this.subscription = subscription
      readyTimeout = setTimeout(
        () =>
          this.fail(
            new RemoteRuntimeClientError('runtime_timeout', 'Port forward attach timed out.'),
            rejectReady
          ),
        this.options.timeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS
      )
      await ready
      if (this.closed || !this.tunnelValue) {
        throw new Error('port_forward_transport_not_retained')
      }
      return this.tunnelValue
    } catch (error) {
      const transportError = asError(error)
      if (!this.closed) {
        this.fail(transportError, rejectReady)
      }
      throw transportError
    } finally {
      if (readyTimeout) {
        clearTimeout(readyTimeout)
      }
      this.rejectPendingReady = null
    }
  }

  private acceptReady(
    tunnelGeneration: number,
    resolveReady: () => void,
    rejectReady: (error: Error) => void
  ): void {
    if (this.tunnelValue) {
      if (this.tunnelValue.generation !== tunnelGeneration) {
        this.fail(new Error('port_forward_generation_changed_in_place'), rejectReady)
      }
      return
    }
    this.tunnelValue = new BrowserNetworkTunnelClient({
      tunnelGeneration,
      sendBinary: (bytes) => this.subscription?.sendBinary(bytes) ?? false,
      onClosed: (error) => this.fail(error, rejectReady)
    })
    resolveReady()
  }

  private fail(error: Error, rejectReady: (error: Error) => void): void {
    if (this.closed) {
      // close() tears the tunnel client down, and its onClosed lands straight back here.
      // Without this an intentional teardown would report itself as a lost tunnel, and a
      // real loss would report itself twice. Settling the attach stays unconditional,
      // since a rejected promise ignores a second rejection.
      rejectReady(error)
      return
    }
    const wasReady = this.tunnelValue !== null
    // Rejected before close() so the caller sees this failure rather than the generic
    // teardown error close() settles a pending attach with.
    rejectReady(error)
    this.close()
    if (wasReady) {
      this.options.onLost?.(error)
    }
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    // An attach still waiting on readiness has no other settler once closed short-circuits
    // fail(), and start() would stay pending for the life of the process.
    this.rejectPendingReady?.(new Error('port_forward_transport_closed'))
    try {
      this.tunnelValue?.close(new Error('port_forward_transport_closed'))
    } finally {
      this.tunnelValue = null
      const subscription = this.subscription
      this.subscription = null
      subscription?.close()
    }
  }
}
