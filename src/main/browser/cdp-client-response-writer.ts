import { WebSocket } from 'ws'

/**
 * Serializes CDP replies to the connected websocket client and echoes the
 * request's sessionId back onto its response.
 */
export class CdpClientResponseWriter {
  private readonly responseSessionIdsByClient = new WeakMap<WebSocket, Map<number, string>>()

  constructor(private readonly getClient: () => WebSocket | null) {}

  send(payload: unknown, client = this.getClient()): void {
    const responsePayload = client ? this.addResponseSessionId(payload, client) : payload
    if (client?.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(responsePayload))
    }
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
  }
}
