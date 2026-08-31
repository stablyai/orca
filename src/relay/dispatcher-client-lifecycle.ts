import { FrameDecoder, KEEPALIVE_SEND_MS, encodeKeepAliveFrame } from './protocol'
import type { PtyConsumerCloseCause } from '../shared/pty-consumer-session-contract'
import type {
  DispatcherClientWriter,
  RelayClientSinkOptions,
  RelayClientWrite
} from './dispatcher-client-writer'
import type {
  RelayClient,
  RelayClientSessionIdentity,
  RelayClientSourceOptions
} from './dispatcher-contract'
import { RelayDispatcherClientState } from './dispatcher-client-state'

export abstract class RelayDispatcherClientLifecycle extends RelayDispatcherClientState {
  // Why: redirect outgoing frames to the reconnected socket without rebuilding the dispatcher + handler tree.
  // Why: a new multiplexer restarts at seq=1; reset state to avoid stalled acknowledgements.
  setWrite(write: RelayClientWrite, sinkOptions?: RelayClientSinkOptions): void {
    this.requestAborts.abortClient(this.primaryClient.id)
    this.primaryClient.closed = true
    this.primaryClient.writer.close(new Error('Relay primary sink replaced'))
    this.resetClient(this.primaryClient)
    this.primaryClient.writer = this.createWriter(this.primaryClient, write, sinkOptions)
    // Why: a frame retained against the replaced sink would otherwise wait for traffic that may never come.
    this.notifyClientCapacity(this.primaryClient.id)
  }

  // Why: mark in-flight requests stale on disconnect so a late pty.spawn/fs.watch can't create unowned remote state.
  invalidateClient(cause: PtyConsumerCloseCause = 'local'): void {
    this.closeClient(
      this.primaryClient,
      new Error('Relay primary client invalidated'),
      false,
      cause
    )
  }

  // Why: seq numbers and request ids are per SSH channel, so each attached client needs independent protocol state.
  attachClient(
    write: RelayClientWrite,
    sinkOptions?: RelayClientSinkOptions,
    sessionIdentity?: RelayClientSessionIdentity,
    sourceOptions?: RelayClientSourceOptions
  ): number {
    const client = this.createClient(write, sinkOptions, sessionIdentity, sourceOptions)
    this.clients.set(client.id, client)
    return client.id
  }

  detachClient(clientId: number, cause: PtyConsumerCloseCause = 'local'): void {
    const client = this.clients.get(clientId)
    if (!client || client === this.primaryClient) {
      return
    }
    this.closeClient(client, new Error('Relay client detached'), true, cause)
  }

  // Why: a displaced owner must lose its transport whichever client holds it, and the launch channel is
  // often the half-open one. The primary keeps its id for setWrite() revival, so invalidate it instead.
  releaseDisplacedClient(clientId: number): void {
    if (clientId === this.primaryClient.id) {
      this.invalidateClient()
      return
    }
    this.detachClient(clientId)
  }

  feedClient(clientId: number, data: Buffer): void {
    const client = this.clients.get(clientId)
    if (!client) {
      return
    }
    this.feedForClient(client, data)
  }

  feed(data: Buffer): void {
    this.feedForClient(this.primaryClient, data)
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
    for (const [id, pending] of this.pendingRelayRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Relay dispatcher disposed'))
      this.pendingRelayRequests.delete(id)
    }
    // Why: can't send responses after dispose; abort in-flight work so SSH-side scans/watchers release.
    this.requestAborts.abortAll()
    for (const client of this.clients.values()) {
      client.closed = true
      client.writer.close(new Error('Relay dispatcher disposed'))
    }
    for (const listener of Array.from(this.legacyCapacityListeners)) {
      listener()
    }
    this.legacyCapacityListeners.clear()
    this.clientCapacityListeners.clear()
    for (const listener of Array.from(this.disposeListeners)) {
      listener()
    }
    this.disposeListeners.clear()
  }

  protected createClient(
    write: RelayClientWrite,
    sinkOptions?: RelayClientSinkOptions,
    sessionIdentity?: RelayClientSessionIdentity,
    sourceOptions?: RelayClientSourceOptions
  ): RelayClient {
    const id = this.nextClientId++
    const client = {
      id,
      decoder: undefined as unknown as FrameDecoder,
      writer: undefined as unknown as DispatcherClientWriter,
      bulkChain: Promise.resolve(),
      nextOutgoingSeq: 1,
      highestReceivedSeq: 0,
      generation: 0,
      closed: false,
      droppedNotificationLog: null,
      sessionIdentity: sessionIdentity ?? {
        principal: `unproved:${id}`,
        authenticated: false,
        allowSessionOwner: false,
        authenticationKind: 'unproved'
      }
    } satisfies RelayClient
    client.decoder = new FrameDecoder(
      (frame) => this.handleFrame(client, frame),
      (error) => this.closeClient(client, error, client !== this.primaryClient),
      { pause: sourceOptions?.pauseReads, resume: sourceOptions?.resumeReads }
    )
    client.writer = this.createWriter(client, write, sinkOptions)
    return client
  }

  protected resetClient(client: RelayClient): void {
    client.nextOutgoingSeq = 1
    client.highestReceivedSeq = 0
    client.decoder.reset()
    client.generation++
    client.closed = false
  }

  protected feedForClient(client: RelayClient, data: Buffer): void {
    if (this.disposed) {
      return
    }
    try {
      client.decoder.feed(data)
    } catch (err) {
      process.stderr.write(
        `[relay] Protocol error: ${err instanceof Error ? err.message : String(err)}\n`
      )
    }
  }

  protected startKeepalive(): void {
    this.keepaliveTimer = setInterval(() => {
      if (this.disposed) {
        return
      }
      for (const client of this.clients.values()) {
        if (client.closed) {
          continue
        }
        client.writer.enqueue(
          'liveness',
          () => {
            const seq = client.nextOutgoingSeq++
            return encodeKeepAliveFrame(seq, client.highestReceivedSeq)
          },
          13
        )
      }
    }, KEEPALIVE_SEND_MS)
    // Why: unref so the keepalive interval doesn't pin the event loop and block process exit.
    this.keepaliveTimer.unref()
  }

  protected closeClient(
    client: RelayClient,
    error: Error,
    remove: boolean,
    // Why the default is the cautious one: most closes here are the relay's own doing, and only the
    // callers holding real evidence of a peer-side transport end may say so.
    cause: PtyConsumerCloseCause = 'local'
  ): void {
    if (client.closed) {
      return
    }
    client.closed = true
    this.requestAborts.abortClient(client.id)
    client.writer.close(error)
    client.generation++
    if (remove) {
      this.clients.delete(client.id)
    }
    this.notifyClientDetached(client.id, cause)
    if (remove) {
      // Only for a client that is gone for good: an invalidated primary is revived by setWrite, and a
      // frame stranded by its retired sink must stay armed to retry. After the detach fan-out, so a
      // listener that unsubscribes on detach is not left holding a stale slot.
      this.clientCapacityListeners.delete(client.id)
    }
    this.notifyLegacyCapacity(true)
    if (!/^Relay (?:primary client invalidated|client detached)$/.test(error.message)) {
      process.stderr.write(`[relay] Client write closed: ${error.message}\n`)
    }
  }

  private notifyClientDetached(clientId: number, cause: PtyConsumerCloseCause): void {
    for (const listener of this.clientDetachListeners) {
      try {
        listener(clientId, cause)
      } catch (err) {
        process.stderr.write(
          `[relay] Client detach listener failed: ${err instanceof Error ? err.message : String(err)}\n`
        )
      }
    }
  }
}
