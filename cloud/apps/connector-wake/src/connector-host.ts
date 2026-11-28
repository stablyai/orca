// One object per connector host (`host:<hostId>`). It holds only the host's wake socket: no
// storage, no alarms, no timers. The runtime answers the desktop's keepalive without waking it.
import { DurableObject } from 'cloudflare:workers'
import {
  CONNECTOR_WAKE_CLOSE_CODE,
  CONNECTOR_WAKE_KEEPALIVE_ACK_FRAME,
  CONNECTOR_WAKE_KEEPALIVE_FRAME,
  CONNECTOR_WAKE_MAX_INBOUND_FRAME_BYTES,
  connectorWakeFrame,
  type ConnectorWakeKind
} from '../../../packages/connector-contract/src/wake-messages'
import type { Env } from './env'
import { metric } from './metrics'

export const HOST_ID_HEADER = 'x-wake-host'
export const PLACE_HEADER = 'x-wake-place'

// Present while the socket counts as connected; cleared on close, error and replace, because
// getWebSockets() still lists a closing socket.
type Attachment = { hostId: string; openedAt: number; place: string }

export type WakeResult = 'delivered' | 'no_socket' | 'error'

function frameOver(message: string | ArrayBuffer, limit: number): boolean {
  if (typeof message !== 'string') { return message.byteLength > limit }
  if (message.length * 3 <= limit) { return false }
  return message.length > limit || new TextEncoder().encode(message).byteLength > limit
}

export class ConnectorHost extends DurableObject<Env> {
  // In memory only: this instance was woken before any socket reached it, so a socket that comes
  // later may be talking to an object placed near the publisher (design W7).
  private wokenWithoutSocket = false

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Before the first socket: answered by the runtime while the object sleeps.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(CONNECTOR_WAKE_KEEPALIVE_FRAME, CONNECTOR_WAKE_KEEPALIVE_ACK_FRAME))
  }

  private attachment(ws: WebSocket): Attachment | null {
    return (ws.deserializeAttachment() as Attachment | null) ?? null
  }

  private live(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => this.attachment(ws) !== null)
  }

  // Upgrade, forwarded by the Worker after auth. The newer socket wins; older ones close 4409.
  async fetch(request: Request): Promise<Response> {
    const hostId = request.headers.get(HOST_ID_HEADER)
    if (!hostId) { return new Response(null, { status: 404 }) }
    const place = request.headers.get(PLACE_HEADER) ?? ''
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
    this.ctx.acceptWebSocket(server, [hostId])
    server.serializeAttachment({ hostId, openedAt: Date.now(), place } satisfies Attachment)
    const older = this.ctx.getWebSockets().filter((ws) => ws !== server && this.attachment(ws) !== null)
    for (const ws of older) { this.drop(ws, CONNECTOR_WAKE_CLOSE_CODE.REPLACED, 'replaced') }
    metric(this.env, 'socket_open', 1, older.length > 0 ? 'replaced' : 'new', [], this.wokenWithoutSocket ? 'raced' : '', place)
    this.wokenWithoutSocket = false
    return new Response(null, { status: 101, webSocket: client })
  }

  // RPC from the Worker's admin wake. Content-free: the frame depends only on the kind.
  async wake(kind?: ConnectorWakeKind): Promise<WakeResult> {
    const frame = connectorWakeFrame(kind)
    const sockets = this.live()
    if (sockets.length === 0) {
      this.wokenWithoutSocket = true
      return 'no_socket'
    }
    let sent = false
    for (const ws of sockets) {
      try {
        ws.send(frame)
        sent = true
      } catch {
        this.drop(ws, 1011, 'send failed')
      }
    }
    return sent ? 'delivered' : 'error'
  }

  async healthCheck(): Promise<{ ok: true }> {
    return { ok: true }
  }

  // Spike only (SPIKE_DEBUG=1): where this object runs, and its sockets' connect places (design W7).
  async spikePlace(): Promise<{ colo: string | null; sockets: string[] }> {
    const trace = await fetch('https://cloudflare.com/cdn-cgi/trace').then((r) => r.text()).catch(() => '')
    const colo = /^colo=(\w+)$/m.exec(trace)?.[1] ?? null
    return { colo, sockets: this.live().map((ws) => this.attachment(ws)?.place ?? '') }
  }

  // Any frame other than the exact keepalive wakes the object. Oversized ones close 1009; others
  // are ignored (a keepalive with different bytes, or a later frame type).
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const a = this.attachment(ws)
    if (!a || !frameOver(message, CONNECTOR_WAKE_MAX_INBOUND_FRAME_BYTES)) { return }
    const place = a.place
    metric(this.env, 'refuse', 1, String(CONNECTOR_WAKE_CLOSE_CODE.FRAME_TOO_BIG), [], 'frame', place)
    this.drop(ws, CONNECTOR_WAKE_CLOSE_CODE.FRAME_TOO_BIG, 'frame too big')
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.gone(ws, code)
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.gone(ws, 1006)
  }

  private gone(ws: WebSocket, code: number): void {
    const a = this.attachment(ws)
    if (!a) { return }
    ws.serializeAttachment(null)
    metric(this.env, 'socket_close', 1, String(code), [], '', a.place)
  }

  private drop(ws: WebSocket, code: number, reason: string): void {
    this.gone(ws, code)
    try {
      ws.close(code, reason)
    } catch {}
  }
}
