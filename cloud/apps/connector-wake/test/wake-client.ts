// A wake socket as the desktop will run it (design §2.4): bearer wake token and gap header on the
// upgrade, the exact keepalive every interval, silence check at 2 intervals, and the close-code
// table from the contract. Used by the protocol test and the spike's synthetic hosts.
import WebSocket from 'ws'
import {
  CONNECTOR_WAKE_FRAME,
  CONNECTOR_WAKE_GAP_HEADER,
  CONNECTOR_WAKE_KEEPALIVE_ACK_FRAME,
  CONNECTOR_WAKE_KEEPALIVE_FRAME,
  CONNECTOR_WAKE_KEEPALIVE_INTERVAL_MS,
  CONNECTOR_WAKE_PATH,
  connectorWakeCloseAction,
  type ConnectorWakeCloseAction
} from '../../../packages/connector-contract/src/wake-messages'

export type WakeSocketState = {
  open: boolean
  // HTTP status of a refused upgrade (401, 429, 503...), with its Retry-After.
  refused: { status: number; retryAfter: string | null } | null
  closed: { code: number; action: ConnectorWakeCloseAction } | null
  wakes: number[]
  frames: string[]
  acks: number
  openedAt: number | null
}

export type WakeSocket = { state: WakeSocketState; ws: WebSocket; send: (frame: string) => void; close: () => void }

export function dialWake(
  origin: string,
  token: string,
  opts: { gapMs?: number; keepaliveMs?: number; onWake?: () => void } = {}
): WakeSocket {
  const state: WakeSocketState = { open: false, refused: null, closed: null, wakes: [], frames: [], acks: 0, openedAt: null }
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (opts.gapMs !== undefined) { headers[CONNECTOR_WAKE_GAP_HEADER] = String(opts.gapMs) }
  const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}${CONNECTOR_WAKE_PATH}`, { headers })
  const interval = opts.keepaliveMs ?? CONNECTOR_WAKE_KEEPALIVE_INTERVAL_MS
  let lastAckAt = 0
  let timer: ReturnType<typeof setInterval> | undefined
  ws.on('unexpected-response', (_req, res) => {
    state.refused = { status: res.statusCode ?? 0, retryAfter: (res.headers['retry-after'] as string | undefined) ?? null }
    ws.terminate()
  })
  ws.on('open', () => {
    state.open = true
    state.openedAt = Date.now()
    lastAckAt = Date.now()
    timer = setInterval(() => {
      // No ack within 2 intervals: the desktop calls the socket dead and reconnects.
      if (Date.now() - lastAckAt > 2 * interval) {
        ws.terminate()
        return
      }
      if (ws.readyState === WebSocket.OPEN) { ws.send(CONNECTOR_WAKE_KEEPALIVE_FRAME) }
    }, interval)
  })
  ws.on('message', (data) => {
    const frame = data.toString()
    state.frames.push(frame)
    if (frame === CONNECTOR_WAKE_KEEPALIVE_ACK_FRAME) {
      state.acks++
      lastAckAt = Date.now()
    } else if (frame === CONNECTOR_WAKE_FRAME) {
      state.wakes.push(Date.now())
      opts.onWake?.()
    }
  })
  ws.on('close', (code) => {
    clearInterval(timer)
    state.open = false
    if (!state.refused) { state.closed = { code, action: connectorWakeCloseAction(code) } }
  })
  ws.on('error', () => {})
  return {
    state,
    ws,
    send: (frame) => ws.send(frame),
    close: () => {
      clearInterval(timer)
      ws.close(1000)
    }
  }
}
