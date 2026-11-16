import {
  chatRendererRetainedBytes,
  noteChatRetainedBytesRefused,
  retainedBytesOf
} from '../native-chat/retention/chat-path-retained-bytes'

/** One chat stream's unacknowledged frames; past this the renderer is not keeping up. */
export const RENDERER_CHAT_IN_FLIGHT_BYTES = 32 * 2 ** 20

/**
 * Charges each chat frame sent to a renderer until the renderer acknowledges processing it, like
 * terminal output. A stream that would go over its share or the chat budget ends instead, and the
 * renderer resumes from its cursor.
 */
export class RendererChatFrameDelivery {
  private readonly frames: ({ bytes: number; release: () => void } | undefined)[] = []
  private head = 0
  private sent = 0
  private acked = 0
  private inFlightBytes = 0

  constructor(signal: AbortSignal) {
    signal.addEventListener('abort', () => this.releaseAll(), { once: true })
  }

  /** False when this frame must not be sent: end the stream instead. */
  charge(frame: unknown): boolean {
    const bytes = retainedBytesOf(frame)
    const release =
      this.sent > this.acked && this.inFlightBytes + bytes > RENDERER_CHAT_IN_FLIGHT_BYTES
        ? null
        : chatRendererRetainedBytes.claim(bytes)
    if (!release) {
      noteChatRetainedBytesRefused()
      return false
    }
    this.frames.push({ bytes, release })
    this.sent += 1
    this.inFlightBytes += bytes
    return true
  }

  /** Cumulative, so a lost ack heals; clamped so a bad count cannot release unsent frames. */
  ack(processedFrames: number): void {
    const next = Math.min(this.sent, Math.max(this.acked, Math.floor(processedFrames)))
    while (this.acked < next) {
      this.releaseHead()
      this.acked += 1
    }
    if (this.head > 64 && this.head * 2 > this.frames.length) {
      this.frames.splice(0, this.head)
      this.head = 0
    }
  }

  inFlight(): { frames: number; bytes: number } {
    return { frames: this.sent - this.acked, bytes: this.inFlightBytes }
  }

  private releaseHead(): void {
    const frame = this.frames[this.head]
    this.frames[this.head] = undefined
    this.head += 1
    if (frame) {
      this.inFlightBytes -= frame.bytes
      frame.release()
    }
  }

  private releaseAll(): void {
    while (this.head < this.frames.length) {
      this.releaseHead()
    }
    this.frames.length = 0
    this.head = 0
    this.acked = this.sent
  }
}
