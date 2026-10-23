import WebSocket from 'ws'

/**
 * The backend-only control connection for one live control call, authenticated with the
 * real API key — never the renderer's ephemeral credential. Purely raw transport:
 * connect, send one JSON event, receive a stream of parsed JSON events, close cleanly.
 * It has no opinion on event shapes; classification and the response gate layer on top.
 * (Port of otto-voice's OpenAiRealtimeSideband.)
 */

const SIDEBAND_CONNECT_DEADLINE_MS = 15_000
const SIDEBAND_PING_INTERVAL_MS = 20_000
const SIDEBAND_PONG_TIMEOUT_MS = 10_000

export type SidebandEventHandler = {
  onEvent(event: Record<string, unknown>): void
  /** A frame that isn't valid JSON: logged and skipped, never fatal. */
  onMalformedFrame(raw: string): void
  onEnded(reason: 'closed' | 'error' | 'liveness', detail: string): void
}

export class RealtimeSidebandSocket {
  private socket: WebSocket | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private ended = false

  constructor(
    private readonly apiKey: string,
    private readonly callId: string,
    private readonly handler: SidebandEventHandler,
    private readonly createSocket: (url: string, apiKey: string) => WebSocket = (url, key) =>
      new WebSocket(url, {
        headers: { authorization: `Bearer ${key}` },
        perMessageDeflate: false
      })
  ) {}

  connect(): Promise<void> {
    const url = `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(this.callId)}`
    return new Promise((resolve, reject) => {
      const socket = this.createSocket(url, this.apiKey)
      this.socket = socket
      const deadline = setTimeout(() => {
        reject(new Error('sideband_connect_timeout'))
        socket.terminate()
      }, SIDEBAND_CONNECT_DEADLINE_MS)
      socket.once('open', () => {
        clearTimeout(deadline)
        this.startLiveness()
        resolve()
      })
      socket.once('error', (error) => {
        clearTimeout(deadline)
        reject(error)
      })
      socket.on('message', (raw, isBinary) => {
        this.notePong()
        const text = raw.toString()
        if (isBinary) {
          this.handler.onMalformedFrame(text)
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          this.handler.onMalformedFrame(text)
          return
        }
        if (typeof parsed === 'object' && parsed !== null) {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: JSON.parse wire boundary; the object/null check above is the full shape contract.
          this.handler.onEvent(parsed as Record<string, unknown>)
        } else {
          this.handler.onMalformedFrame(text)
        }
      })
      socket.on('pong', () => this.notePong())
      socket.on('close', (code, reason) => this.end('closed', `${code}: ${reason.toString()}`))
      socket.on('error', (error) => this.end('error', error.message))
    })
  }

  send(event: Record<string, unknown>): void {
    if (this.ended || this.socket?.readyState !== WebSocket.OPEN) {
      return
    }
    this.socket.send(JSON.stringify(event))
  }

  close(): void {
    if (this.ended) {
      return
    }
    this.ended = true
    this.stopLiveness()
    this.socket?.close()
    this.socket = null
  }

  private startLiveness(): void {
    this.pingTimer = setInterval(() => {
      this.socket?.ping()
      this.pongTimer = setTimeout(() => {
        this.end('liveness', 'pong timeout')
        this.socket?.terminate()
      }, SIDEBAND_PONG_TIMEOUT_MS)
    }, SIDEBAND_PING_INTERVAL_MS)
  }

  private notePong(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
  }

  private stopLiveness(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    this.notePong()
  }

  private end(reason: 'closed' | 'error' | 'liveness', detail: string): void {
    if (this.ended) {
      return
    }
    this.ended = true
    this.stopLiveness()
    this.handler.onEnded(reason, detail)
  }
}
