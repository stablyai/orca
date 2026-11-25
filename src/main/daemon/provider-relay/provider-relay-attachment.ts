import type { ProviderRelayRecord } from '../protocol/daemon-provider-relay-protocol'
import { streamFramesFor } from '../transport/framing/daemon-stream-data-split'
import {
  BINARY_STREAM_FRAMING,
  encodeBinaryRelayLineFrame,
  type DaemonStreamFraming
} from '../transport/framing/daemon-stream-binary-framing'
import { isHighSurrogate } from './provider-relay-input'

/** Keeps each event frame well under the stream's line cap even after JSON escaping. */
const EVENT_PIECE_CHARS = 1024 * 1024
/** How often a paused relay asks its client again for an ack. */
export const RELAY_ACK_NUDGE_MS = 2_000

/** A piece never ends between the halves of a surrogate pair, so each piece encodes as UTF-8. */
function pieceEnd(line: string, offset: number): number {
  const end = Math.min(offset + EVENT_PIECE_CHARS, line.length)
  return end < line.length && isHighSurrogate(line.charCodeAt(end - 1)) ? end - 1 : end
}

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

  private nudge: ReturnType<typeof setInterval> | null = null

  release(): void {
    if (this.released) {
      return
    }
    this.released = true
    this.whilePaused(false, () => null)
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
    let offset = 0
    do {
      const end = pieceEnd(line, offset)
      this.sendPiece(event, seq, line.slice(offset, end), end < line.length)
      offset = end
    } while (offset < line.length)
  }

  /** Sends a line in pieces, waiting for the socket after each; false once released. */
  async sendPieces(event: ProviderRelayLineEvent, seq: number, line: string): Promise<boolean> {
    let offset = 0
    do {
      const end = pieceEnd(line, offset)
      this.sendPiece(event, seq, line.slice(offset, end), end < line.length)
      offset = end
      await this.drained()
      if (this.released) {
        return false
      }
    } while (offset < line.length)
    return true
  }

  /** Unanswered requests, in seq order; false once released. */
  async sendPending(records: ProviderRelayRecord[]): Promise<boolean> {
    for (const { seq, line } of records) {
      if (!(await this.sendPieces('relayPending', seq, line))) {
        return false
      }
    }
    return true
  }

  /**
   * While the relay is paused at its cap the ask goes again on a timer, so an answer that fell
   * short or went missing never stalls the agent. `askedSeq` is null when there is nothing to ask.
   */
  whilePaused(paused: boolean, askedSeq: () => number | null): void {
    if (paused && !this.nudge && !this.released) {
      this.nudge = setInterval(() => {
        const seq = askedSeq()
        if (seq !== null) {
          this.askForAck(seq)
        }
      }, RELAY_ACK_NUDGE_MS)
      this.nudge.unref?.()
    } else if (!paused && this.nudge) {
      clearInterval(this.nudge)
      this.nudge = null
    }
  }

  askForAck(seq: number): void {
    this.send({ type: 'event', event: 'relayAckWanted', sessionId: this.relayId, payload: { seq } })
  }

  /** A binary stream carries the piece as raw bytes; an NDJSON one gets the JSON event. */
  private sendPiece(
    event: ProviderRelayLineEvent,
    seq: number,
    piece: string,
    more: boolean
  ): void {
    const { socket, framing } = this.stream
    if (this.released || socket.destroyed) {
      return
    }
    const payload = more ? { seq, more: true as const } : { seq }
    const frame =
      framing === BINARY_STREAM_FRAMING
        ? encodeBinaryRelayLineFrame(this.relayId, event, payload, piece)
        : null
    socket.write(
      frame ??
        streamFramesFor(framing).control({
          type: 'event',
          event,
          sessionId: this.relayId,
          payload: { ...payload, line: piece }
        })
    )
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
}
