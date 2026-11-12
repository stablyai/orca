import { request as httpRequest, type ClientRequest } from 'node:http'
import type { Socket } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { errorMessage } from '../../shared/error-message'
import { AvccFrameParser, type AvccFrame } from './avcc-frame-parser'

// serve-sim re-sends unchanged screens at ~5 fps, so seconds of socket silence mean a dead stream.
const STALL_MS = 3_000

export type AvccFrameStreamCallbacks = {
  onError: (message: string) => void
  onFrame: (frame: AvccFrame) => void
}

export class AvccFrameStream {
  private readonly parser: AvccFrameParser
  private request: ClientRequest | null = null
  private lastDataAt = 0
  private stopped = false

  constructor(
    private readonly streamUrl: string,
    private readonly callbacks: AvccFrameStreamCallbacks,
    private readonly stallMs = STALL_MS
  ) {
    this.parser = new AvccFrameParser((frame) => {
      if (!this.stopped) {
        this.callbacks.onFrame(frame)
      }
    })
  }

  start(): void {
    const url = new URL(this.streamUrl)
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, (response) => {
      if (this.stopped) {
        response.destroy()
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        this.fail(`Simulator video stream returned HTTP ${response.statusCode}.`)
        return
      }
      response.on('data', (chunk: Buffer) => {
        // serve-sim sends nothing until capture starts; the renderer's first-frame timeout covers that wait.
        if (this.lastDataAt === 0) {
          this.watchForStall(response.socket)
        }
        this.lastDataAt = Date.now()
        try {
          this.parser.push(chunk)
        } catch (error) {
          this.fail(errorMessage(error))
        }
      })
      response.on('error', (error) => this.fail(error.message))
      response.on('close', () => this.fail('Simulator video stream closed.'))
    })
    this.request = request
    request.on('error', (error) => this.fail(error.message))
    request.end()
  }

  stop(): void {
    this.stopped = true
    this.request?.destroy()
    this.request = null
  }

  private watchForStall(socket: Socket): void {
    socket.setTimeout(this.stallMs)
    socket.on('timeout', () => {
      const idleSince = this.lastDataAt
      const late = Date.now() - idleSince > 1.5 * this.stallMs
      // Overdue timers run before queued socket data is read; sleep makes them overdue with none queued.
      setImmediate(() => {
        if (!late && this.lastDataAt === idleSince) {
          this.fail('Simulator video stream stalled.')
          return
        }
        this.lastDataAt = Date.now()
        socket.setTimeout(this.stallMs)
      })
    })
  }

  private fail(message: string): void {
    if (this.stopped) {
      return
    }
    this.stop()
    this.callbacks.onError(message)
  }
}
