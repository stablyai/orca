import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { extractJpegFrames } from './mjpeg-frame-parser'

const RECONNECT_DELAY_MS = 1_000
const REQUEST_TIMEOUT_MS = 10_000
const MAX_FPS = 30
const MIN_FRAME_INTERVAL_MS = Math.floor(1_000 / MAX_FPS)

export type MjpegFrameStreamCallbacks = {
  onError: (message: string) => void
  onFrame: (frame: Buffer<ArrayBufferLike>) => void
}

function normalizeStreamUrl(streamUrl: string, streamKey?: string): URL {
  const url = new URL(streamUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Simulator stream must use http or https.')
  }
  if (!url.pathname.endsWith('/stream.mjpeg')) {
    throw new Error('Simulator stream must target stream.mjpeg.')
  }
  url.searchParams.set('raw', '1')
  if (streamKey) {
    url.searchParams.set('_orca', streamKey)
  }
  return url
}

function requestForUrl(url: URL, response: (res: IncomingMessage) => void): ClientRequest {
  return (url.protocol === 'https:' ? httpsRequest : httpRequest)(
    url,
    {
      headers: {
        Accept: 'application/octet-stream, image/jpeg'
      },
      timeout: REQUEST_TIMEOUT_MS
    },
    response
  )
}

export class MjpegFrameStream {
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private reconnectTimer: NodeJS.Timeout | null = null
  private request: ClientRequest | null = null
  private stopped = false
  private lastFrameAt = 0

  private readonly streamUrl: URL
  private readonly callbacks: MjpegFrameStreamCallbacks

  constructor(streamUrl: string, callbacks: MjpegFrameStreamCallbacks, streamKey?: string) {
    this.streamUrl = normalizeStreamUrl(streamUrl, streamKey)
    this.callbacks = callbacks
  }

  start(): void {
    this.openRequest()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.request?.destroy()
    this.request = null
    this.pending = Buffer.alloc(0)
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openRequest()
    }, RECONNECT_DELAY_MS)
  }

  private openRequest(): void {
    if (this.stopped) {
      return
    }

    const req = requestForUrl(this.streamUrl, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        this.callbacks.onError(`Simulator stream returned HTTP ${res.statusCode}.`)
        res.resume()
        this.scheduleReconnect()
        return
      }

      res.on('data', (chunk: Buffer) => this.handleChunk(chunk))
      res.on('end', () => this.scheduleReconnect())
      res.on('error', (error) => {
        this.callbacks.onError(error.message)
        this.scheduleReconnect()
      })
    })

    this.request = req
    req.on('timeout', () => req.destroy(new Error('Simulator stream timed out.')))
    req.on('error', (error) => {
      if (this.stopped) {
        return
      }
      this.callbacks.onError(error.message)
      this.scheduleReconnect()
    })
    req.end()
  }

  private handleChunk(chunk: Buffer<ArrayBufferLike>): void {
    const result = extractJpegFrames(this.pending, chunk)
    this.pending = result.pending
    for (const frame of result.frames) {
      const now = Date.now()
      if (this.lastFrameAt > 0 && now - this.lastFrameAt < MIN_FRAME_INTERVAL_MS) {
        continue
      }
      this.lastFrameAt = now
      this.callbacks.onFrame(frame)
    }
  }
}
