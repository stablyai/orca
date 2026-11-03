import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { AvccFrameParser, type AvccFrame } from './avcc-frame-parser'

const REQUEST_TIMEOUT_MS = 10_000

export type AvccFrameStreamCallbacks = {
  onError: (message: string) => void
  onFrame: (frame: AvccFrame) => void
}

export class AvccFrameStream {
  private readonly streamUrl: URL
  private readonly parser: AvccFrameParser
  private request: ClientRequest | null = null
  private response: IncomingMessage | null = null
  private handshakeTimer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(
    streamUrl: string,
    private readonly callbacks: AvccFrameStreamCallbacks
  ) {
    this.streamUrl = new URL(streamUrl)
    if (this.streamUrl.protocol !== 'http:' && this.streamUrl.protocol !== 'https:') {
      throw new Error('Simulator AVCC stream must use http or https.')
    }
    if (!this.streamUrl.pathname.endsWith('/stream.avcc')) {
      throw new Error('Simulator AVCC stream must target stream.avcc.')
    }
    this.parser = new AvccFrameParser((frame) => {
      if (!this.stopped) {
        this.callbacks.onFrame(frame)
      }
    })
  }

  start(): void {
    if (this.stopped) {
      return
    }
    const request = (this.streamUrl.protocol === 'https:' ? httpsRequest : httpRequest)(
      this.streamUrl,
      { headers: { Accept: 'application/octet-stream' } },
      (response) => {
        if (this.stopped) {
          response.destroy()
          return
        }
        this.response = response
        this.clearHandshakeTimer()
        response.on('error', (error) => this.fail(error.message))
        response.on('end', () => this.fail('Simulator AVCC stream ended.'))
        response.on('close', () => this.fail('Simulator AVCC stream closed unexpectedly.'))
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          this.fail(`Simulator AVCC stream returned HTTP ${response.statusCode}.`)
          return
        }
        response.on('data', (chunk: Buffer) => {
          if (this.stopped) {
            return
          }
          try {
            this.parser.push(chunk)
          } catch (error) {
            this.fail(error instanceof Error ? error.message : String(error))
          }
        })
      }
    )
    this.request = request
    this.handshakeTimer = setTimeout(
      () => this.fail('Simulator AVCC stream handshake timed out.'),
      REQUEST_TIMEOUT_MS
    )
    request.on('error', (error) => this.fail(error.message))
    request.end()
  }

  stop(): void {
    this.stopped = true
    this.clearHandshakeTimer()
    this.response?.destroy()
    this.response = null
    this.request?.destroy()
    this.request = null
    this.parser.reset()
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
  }

  private fail(message: string): void {
    if (this.stopped) {
      return
    }
    this.stop()
    this.callbacks.onError(message)
  }
}
