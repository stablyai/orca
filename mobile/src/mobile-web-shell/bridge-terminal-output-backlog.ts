import { terminalStreamJsonByteLength } from '../../../src/shared/terminal-stream-json-byte-length'
import { BRIDGE_MAX_MESSAGE_BYTES, utf8ByteLength } from './bridge/bridge-caps'
import { bridgeEventEnvelopeBytes } from './bridge/bridge-event-envelope-bytes'

// Hold and merge terminal output rather than dropping bytes or killing ordinary cat bursts; measured host JSON (70.3 MiB/s) outruns xterm (2.2 MiB/s) and fills 4 MiB in 62 ms.
// End only for an unresponsive page or process-memory ceiling; the page is told so it can resubscribe.

// A full 4 MiB window drains in about 1.9 seconds at measured xterm speed; allow an order-of-magnitude margin for GC, background tabs and large pastes.
export const TERMINAL_STREAM_ACK_SILENCE_MS = 20_000

// Bound phone-process memory; at 2.2 MiB/s this backlog drains in about 15 seconds, within the silence bound, so healthy slow pages are paced rather than killed.
export const TERMINAL_STREAM_MAX_PENDING_BYTES = 32 * 1024 * 1024

export type TerminalBacklogEnd = 'ack-silence' | 'pending-ceiling'

export const TERMINAL_STREAM_METHOD = 'terminal.subscribe'

export function holdsTerminalOutput(method: string): boolean {
  return method === TERMINAL_STREAM_METHOD
}

export type TerminalBacklogTimers = {
  set: (handler: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const REAL_TIMERS: TerminalBacklogTimers = {
  set: (handler, ms) => setTimeout(handler, ms),
  clear: (handle) => {
    if (typeof handle === 'number' || typeof handle === 'object') {
      // `clearTimeout` accepts both shapes; Node's handle is an object and a browser's a number.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handle came from this module's own `set`, which returns exactly what `clearTimeout` takes.
      clearTimeout(handle as Parameters<typeof clearTimeout>[0])
    }
  }
}

type TerminalOutputPayload = { type: 'data'; streamId: number; chunk: string }

// Merge only output payloads; snapshots, resizes, metadata and subscribe acknowledgements carry ordered state and must remain whole.
function readTerminalOutput(payload: unknown): TerminalOutputPayload | null {
  if (payload === null || typeof payload !== 'object') {
    return null
  }
  const record: Record<string, unknown> = { ...payload }
  return record.type === 'data' &&
    typeof record.streamId === 'number' &&
    typeof record.chunk === 'string'
    ? { type: 'data', streamId: record.streamId, chunk: record.chunk }
    : null
}

function outputPayloadBytes(streamId: number, chunk: string): number {
  return (
    JSON.stringify({ type: 'data', streamId, chunk: '' }).length +
    terminalStreamJsonByteLength(chunk) -
    // The skeleton already counted the empty string's two quotes, which the measure counts again.
    2
  )
}

type Held =
  | { kind: 'output'; streamId: number; chunk: string; bytes: number }
  | { kind: 'other'; payload: unknown; bytes: number }

// Each backlog belongs to one subscription with one stream id; never multiplex ids or merges would corrupt output. Entries leave only when delivered or the stream ends visibly.
export class BridgeTerminalOutputBacklog {
  private queue: (Held | undefined)[] = []
  private head = 0
  private pending = 0
  private peak = 0
  private merged = 0
  private frames = 0
  private silence: unknown = null

  constructor(
    private readonly options: {
      onAckSilence: () => void
      timers?: TerminalBacklogTimers
    }
  ) {}

  get pendingBytes(): number {
    return this.pending
  }

  get peakPendingBytes(): number {
    return this.peak
  }

  get coalescedFrames(): number {
    return this.merged
  }

  get deliveredFrames(): number {
    return this.frames
  }

  get held(): boolean {
    return this.head < this.queue.length
  }

  // Retain even the ceiling-breaking payload; false tells the caller to end the stream, not silently drop an entry.
  hold(payload: unknown): boolean {
    const output = readTerminalOutput(payload)
    if (output === null) {
      const bytes = utf8ByteLength(JSON.stringify(payload) ?? 'null')
      this.queue.push({ kind: 'other', payload, bytes })
      this.add(bytes)
    } else {
      const bytes = outputPayloadBytes(output.streamId, output.chunk)
      this.queue.push({ kind: 'output', streamId: output.streamId, chunk: output.chunk, bytes })
      this.add(bytes)
    }
    this.syncSilence()
    return this.pending <= TERMINAL_STREAM_MAX_PENDING_BYTES
  }

  // allowedBytes already includes the frame/window limit. A nonfitting head waits for an ack, except when the window is empty: then pass it to the ledger’s cap check because no later ack can add room.
  next(allowedBytes: number, windowEmpty: boolean): unknown | null {
    const head = this.queue[this.head]
    if (head === undefined) {
      return null
    }
    if (head.bytes > allowedBytes && !windowEmpty) {
      return null
    }
    this.removeHead()
    this.take(head.bytes)
    this.frames += 1
    if (head.kind === 'other') {
      this.syncSilence()
      return head.payload
    }
    const chunks = [head.chunk]
    let bytes = head.bytes
    let lastUnit = head.chunk.charCodeAt(head.chunk.length - 1)
    // Merge consecutive output only; intervening state must stay ordered. Stream ids need no comparison because the backlog owns one subscription.
    while (this.held) {
      const nextHeld = this.queue[this.head]
      if (nextHeld?.kind !== 'output') {
        break
      }
      const firstUnit = nextHeld.chunk.charCodeAt(0)
      // Joining lone surrogate halves replaces two six-byte escapes with one four-byte scalar.
      const joinedPair =
        lastUnit >= 0xd800 && lastUnit <= 0xdbff && firstUnit >= 0xdc00 && firstUnit <= 0xdfff
      const mergedBytes =
        bytes + nextHeld.bytes - outputPayloadBytes(nextHeld.streamId, '') - (joinedPair ? 8 : 0)
      if (mergedBytes > allowedBytes) {
        break
      }
      this.removeHead()
      this.take(nextHeld.bytes)
      chunks.push(nextHeld.chunk)
      bytes = mergedBytes
      if (nextHeld.chunk.length > 0) {
        lastUnit = nextHeld.chunk.charCodeAt(nextHeld.chunk.length - 1)
      }
      this.merged += 1
    }
    this.syncSilence()
    return { type: 'data', streamId: head.streamId, chunk: chunks.join('') }
  }

  noteAck(): void {
    this.clearSilence()
    this.syncSilence()
  }

  dispose(): void {
    this.clearSilence()
    this.queue.length = 0
    this.head = 0
    this.pending = 0
  }

  private removeHead(): void {
    this.queue[this.head] = undefined
    this.head += 1
    // Amortize compaction without retaining delivered payloads.
    if (
      this.head === this.queue.length ||
      (this.head >= 1024 && this.head * 2 >= this.queue.length)
    ) {
      this.queue = this.queue.slice(this.head)
      this.head = 0
    }
  }

  private add(bytes: number): void {
    this.pending += bytes
    this.peak = Math.max(this.peak, this.pending)
  }

  private take(bytes: number): void {
    this.pending = Math.max(0, this.pending - bytes)
  }

  // Arm only while output is pending; the final drain must clear the clock even if no further acknowledgement arrives, or an idle terminal dies on overflow.
  private syncSilence(): void {
    if (!this.held) {
      this.clearSilence()
      return
    }
    this.armSilence()
  }

  private armSilence(): void {
    if (this.silence !== null) {
      return
    }
    const timers = this.options.timers ?? REAL_TIMERS
    this.silence = timers.set(() => {
      this.silence = null
      this.options.onAckSilence()
    }, TERMINAL_STREAM_ACK_SILENCE_MS)
  }

  private clearSilence(): void {
    if (this.silence === null) {
      return
    }
    const timers = this.options.timers ?? REAL_TIMERS
    timers.clear(this.silence)
    this.silence = null
  }
}

// Derive payload room from the real envelope/id and widest seq; exceeding it creates a frame the page drops, defeating lossless holding.
export function terminalStreamMaxPayloadBytes(id: string): number {
  return BRIDGE_MAX_MESSAGE_BYTES - bridgeEventEnvelopeBytes(id)
}

// Recheck window room on every pass; an empty window may release an oversized head for the ledger’s cap verdict, since no further ack can make more room.
// Backlog owns output pacing; the ledger owns frame cost and retirement.
export function drainTerminalBacklog(deps: {
  backlog: BridgeTerminalOutputBacklog
  maxPayloadBytes: number
  windowHasRoom: () => boolean
  availableWindowBytes: () => number
  windowEmpty: () => boolean
  send: (payload: unknown) => 'sent' | 'retired'
}): void {
  while (deps.backlog.held && deps.windowHasRoom()) {
    const available = Math.min(deps.maxPayloadBytes, Math.max(0, deps.availableWindowBytes()))
    const payload = deps.backlog.next(available, deps.windowEmpty())
    if (payload === null || deps.send(payload) === 'retired') {
      return
    }
  }
}
