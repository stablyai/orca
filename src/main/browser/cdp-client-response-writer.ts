import { WebSocket } from 'ws'
import {
  createWsOutboundBackpressureQueue,
  type WsOutboundBackpressureQueue
} from '../../shared/ws-outbound-backpressure-queue'

/**
 * Serializes CDP replies to the connected websocket client and echoes the
 * request's sessionId back onto its response.
 */
export class CdpClientResponseWriter {
  private readonly responseSessionIdsByClient = new WeakMap<WebSocket, Map<number, string>>()
  private readonly outboundByClient = new WeakMap<
    WebSocket,
    { queue: WsOutboundBackpressureQueue<string>; onClose: () => void }
  >()

  constructor(private readonly getClient: () => WebSocket | null) {}

  send(payload: unknown, client = this.getClient()): void {
    const responsePayload = client ? this.addResponseSessionId(payload, client) : payload
    if (client?.readyState === WebSocket.OPEN) {
      this.outboundQueue(client).enqueue(JSON.stringify(responsePayload))
    }
  }

  private outboundQueue(client: WebSocket): WsOutboundBackpressureQueue<string> {
    const existing = this.outboundByClient.get(client)
    if (existing) {
      return existing.queue
    }
    const queue = createWsOutboundBackpressureQueue<string>({
      send: (frame) => client.send(frame),
      byteLengthOf: (frame) => Buffer.byteLength(frame),
      getBufferedAmount: () => client.bufferedAmount,
      isWritable: () => client.readyState === WebSocket.OPEN,
      onOverflow: (evidence) => {
        // The client only sees an abrupt socket close, so name the cap here.
        console.warn('[cdp] outbound queue overflow; terminating automation client:', {
          cap: evidence.cap,
          queuedBytes: evidence.queuedBytes,
          queuedFrames: evidence.queuedFrames,
          maxQueuedBytes: evidence.maxQueuedBytes,
          maxQueuedFrames: evidence.maxQueuedFrames
        })
        client.terminate()
      },
      // Preserve large PDF/screenshot replies on a draining connection; queued bursts stay capped.
      maxFrameBytes: Number.POSITIVE_INFINITY,
      maxDrainFramesPerTurn: 128
    })
    const onClose = (): void => this.forgetClient(client)
    this.outboundByClient.set(client, { queue, onClose })
    client.once('close', onClose)
    return queue
  }

  private addResponseSessionId(payload: unknown, client: WebSocket): unknown {
    if (typeof payload !== 'object' || payload === null) {
      return payload
    }
    const clientId = (payload as { id?: unknown }).id
    if (typeof clientId !== 'number') {
      return payload
    }
    const responseSessionIds = this.responseSessionIdsByClient.get(client)
    const sessionId = responseSessionIds?.get(clientId)
    responseSessionIds?.delete(clientId)
    return sessionId ? { ...payload, sessionId } : payload
  }

  sendResult(clientId: number, result: unknown, client = this.getClient()): void {
    this.send({ id: clientId, result }, client)
  }

  sendError(clientId: number, message: string, client = this.getClient()): void {
    this.send({ id: clientId, error: { code: -32000, message } }, client)
  }

  isActiveClient(client: WebSocket): boolean {
    return this.getClient() === client && client.readyState === WebSocket.OPEN
  }

  recordRequestSessionId(client: WebSocket, clientId: number, msg: { sessionId?: string }): void {
    const responseSessionIds = this.responseSessionIdsByClient.get(client) ?? new Map()
    if (msg.sessionId) {
      responseSessionIds.set(clientId, msg.sessionId)
    } else {
      responseSessionIds.delete(clientId)
    }
    this.responseSessionIdsByClient.set(client, responseSessionIds)
  }

  forgetClient(client: WebSocket): void {
    this.responseSessionIdsByClient.delete(client)
    const outbound = this.outboundByClient.get(client)
    if (outbound) {
      this.outboundByClient.delete(client)
      client.off('close', outbound.onClose)
      outbound.queue.dispose()
    }
  }
}
