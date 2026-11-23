import type { ProviderRelayRecord } from '../protocol/daemon-provider-relay-protocol'
import { streamFramesFor } from '../transport/framing/daemon-stream-data-split'
import type { DaemonStreamFraming } from '../transport/framing/daemon-stream-binary-framing'

/** Keeps each event frame well under the stream's line cap even after JSON escaping. */
const EVENT_PIECE_CHARS = 1024 * 1024

/** The client's event stream; its close detaches the relay, as a closing stream detaches a PTY. */
export type ProviderRelayStream = {
  socket: {
    write(chunk: string | Uint8Array): unknown
    once(event: 'close' | 'drain', listener: () => void): unknown
    off(event: 'close' | 'drain', listener: () => void): unknown
    readonly destroyed: boolean
    readonly writableNeedDrain?: boolean
  }
  framing?: DaemonStreamFraming
}

export type ProviderRelayLineEvent = 'relayData' | 'relayPending' | 'relayInitialize'

/** One client's hold on a relay. Once released (detach or takeover) it sends nothing and waits on nothing. */
export class ProviderRelayAttachment {
  /** Drain waits in flight; release settles them so a client that stops reading holds nothing. */
  private readonly waits = new Set<() => void>()
  private released = false

  constructor(
    readonly clientId: string,
    private readonly stream: ProviderRelayStream,
    private readonly relayId: string,
    private readonly onClose: () => void
  ) {
    stream.socket.once('close', onClose)
  }

  get active(): boolean {
    return !this.released
  }

  release(): void {
    if (this.released) {
      return
    }
    this.released = true
    this.stream.socket.off('close', this.onClose)
    for (const settle of this.waits) {
      settle()
    }
  }

  /** True when the event was handed to the client's socket. */
  send(event: unknown): boolean {
    const { socket, framing } = this.stream
    if (this.released || socket.destroyed) {
      return false
    }
    socket.write(streamFramesFor(framing).control(event))
    return true
  }

  sendLine(event: ProviderRelayLineEvent, { seq, line }: ProviderRelayRecord): void {
    if (line.length <= EVENT_PIECE_CHARS) {
      this.send(this.lineEvent(event, seq, line))
      return
    }
    for (let offset = 0; offset < line.length; offset += EVENT_PIECE_CHARS) {
      const end = offset + EVENT_PIECE_CHARS
      this.send(this.lineEvent(event, seq, line.slice(offset, end), end < line.length))
    }
  }

  /** Sends a line in pieces, waiting for the socket after each; false once released. */
  async sendPieces(event: ProviderRelayLineEvent, seq: number, line: string): Promise<boolean> {
    for (let offset = 0; offset < line.length || offset === 0; offset += EVENT_PIECE_CHARS) {
      const end = offset + EVENT_PIECE_CHARS
      this.send(this.lineEvent(event, seq, line.slice(offset, end), end < line.length))
      await this.drained()
      if (this.released) {
        return false
      }
    }
    return true
  }

  drained(): Promise<void> {
    const { socket } = this.stream
    if (this.released || !socket.writableNeedDrain || socket.destroyed) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const done = (): void => {
        socket.off('drain', done)
        socket.off('close', done)
        this.waits.delete(done)
        resolve()
      }
      this.waits.add(done)
      socket.once('drain', done)
      socket.once('close', done)
    })
  }

  private lineEvent(event: ProviderRelayLineEvent, seq: number, line: string, more = false) {
    return {
      type: 'event',
      event,
      sessionId: this.relayId,
      payload: more ? { seq, line, more: true } : { seq, line }
    }
  }
}
