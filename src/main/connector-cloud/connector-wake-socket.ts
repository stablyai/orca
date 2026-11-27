// One wake socket: it only says "poll now". Keepalives go out every interval; the cloud answers them.
import WebSocket, { type RawData } from 'ws'
import {
  CONNECTOR_WAKE_CLOSE_CODE,
  CONNECTOR_WAKE_FRAME,
  CONNECTOR_WAKE_GAP_HEADER,
  CONNECTOR_WAKE_KEEPALIVE_FRAME,
  CONNECTOR_WAKE_KEEPALIVE_INTERVAL_MS,
  CONNECTOR_WAKE_MAX_INBOUND_FRAME_BYTES,
  connectorWakeCloseAction,
  type ConnectorWakeCloseAction
} from '../../../cloud/packages/connector-contract/src/wake-messages'

const HANDSHAKE_TIMEOUT_MS = 15_000
// A keepalive tick later than this ran after the process was held back (App Nap, sleep).
const STALLED_TICK_MS = 1.5 * CONNECTOR_WAKE_KEEPALIVE_INTERVAL_MS

/** How a socket ended: before it opened (`opened` false) or after. */
export type ConnectorWakeSocketEnd = {
  opened: boolean
  action: ConnectorWakeCloseAction
  /** A 503's Retry-After, before the upgrade. */
  retryAfterMs: number | null
  code: number | null
}

export type ConnectorWakeSocketLike = Pick<
  WebSocket,
  'send' | 'close' | 'terminate' | 'readyState'
> & {
  on(event: 'open', listener: () => void): unknown
  on(event: 'message', listener: (data: RawData) => void): unknown
  on(event: 'close', listener: (code: number) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(
    event: 'unexpected-response',
    listener: (
      request: unknown,
      response: { statusCode?: number; headers: Record<string, unknown> }
    ) => void
  ): unknown
}

export type ConnectorWakeSocketFactory = (
  url: string,
  headers: Record<string, string>
) => ConnectorWakeSocketLike

export const createConnectorWakeSocket: ConnectorWakeSocketFactory = (url, headers) =>
  new WebSocket(url, {
    headers,
    perMessageDeflate: false,
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    maxPayload: CONNECTOR_WAKE_MAX_INBOUND_FRAME_BYTES
  })

export type ConnectorWakeSocketHandlers = {
  opened(): void
  wake(): void
  /** Called once. */
  ended(end: ConnectorWakeSocketEnd): void
}

function retryAfterMs(header: unknown): number | null {
  const seconds = Number(Array.isArray(header) ? header[0] : header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null
}

/** Opens one socket; `close()` ends it without calling `ended`. */
export function openConnectorWakeSocket(
  url: string,
  token: string,
  gapMs: number | null,
  handlers: ConnectorWakeSocketHandlers,
  factory: ConnectorWakeSocketFactory = createConnectorWakeSocket
): { close(): void } {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (gapMs !== null) {
    headers[CONNECTOR_WAKE_GAP_HEADER] = String(Math.max(0, Math.round(gapMs)))
  }
  const socket = factory(url, headers)
  let opened = false
  let done = false
  let preUpgrade: { status: number; retryAfterMs: number | null } | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let lastTickAt = 0
  let lastHeardAt = 0
  let lastSentAt = 0
  // Keepalives in a row with nothing heard back; two mean the link is dead.
  let unanswered = 0
  const interval = CONNECTOR_WAKE_KEEPALIVE_INTERVAL_MS

  const finish = (end: ConnectorWakeSocketEnd | null): void => {
    if (done) {
      return
    }
    done = true
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    if (end) {
      handlers.ended(end)
    }
  }
  const tick = (): void => {
    const now = Date.now()
    // The App Nap guard (#40010): a tick this late means this process didn't run, so an ack may be
    // waiting unread. It doesn't count as a miss; this tick's keepalive is judged on the next one.
    const stalled = now - lastTickAt > STALLED_TICK_MS
    lastTickAt = now
    if (lastHeardAt >= lastSentAt) {
      unanswered = 0
    } else if (!stalled) {
      unanswered++
    }
    if (unanswered >= 2) {
      socket.terminate()
      finish({ opened, action: 'backoff', retryAfterMs: null, code: null })
      return
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(CONNECTOR_WAKE_KEEPALIVE_FRAME)
      lastSentAt = now
    }
  }

  socket.on('open', () => {
    if (done) {
      return
    }
    opened = true
    lastTickAt = lastHeardAt = Date.now()
    timer = setInterval(tick, interval)
    timer.unref?.()
    handlers.opened()
  })
  socket.on('message', (data) => {
    lastHeardAt = Date.now()
    const frame = data.toString()
    if (frame === CONNECTOR_WAKE_FRAME && !done) {
      handlers.wake()
    }
    // Anything else (the keepalive ack, a newer cloud's frame) only proves the link.
  })
  socket.on('unexpected-response', (_request, response) => {
    const status = response.statusCode ?? 0
    preUpgrade = { status, retryAfterMs: retryAfterMs(response.headers['retry-after']) }
    socket.terminate()
  })
  socket.on('error', () => {
    // 'close' follows and reports the end.
  })
  socket.on('close', (code) => {
    if (preUpgrade) {
      const { status } = preUpgrade
      const action = status === 401 ? 'refresh-token' : 'backoff'
      finish({ opened: false, action, retryAfterMs: preUpgrade.retryAfterMs, code: status })
      return
    }
    if (code === CONNECTOR_WAKE_CLOSE_CODE.FRAME_TOO_BIG) {
      console.error('[connector] wake socket closed: frame too big')
    }
    finish({ opened, action: connectorWakeCloseAction(code), retryAfterMs: null, code })
  })

  return {
    close: () => {
      finish(null)
      socket.close()
    }
  }
}
