import { terminalStreamJsonByteLength } from '../../../src/shared/terminal-stream-json-byte-length'
import { BRIDGE_MAX_MESSAGE_BYTES, utf8ByteLength } from './bridge/bridge-caps'
import { bridgeEventEnvelopeBytes } from './bridge/bridge-event-envelope-bytes'

/**
 * What the shell does with terminal output the page has not caught up with.
 *
 * Every other stream has a backpressure window and ends when the page falls behind it, which is
 * right for a stream whose reader can survive a gap. A terminal's cannot: a missing chunk is
 * invisible in a transcript, so the choice is between holding the bytes and killing the pane, and
 * the window as it stands kills it under an ordinary `cat`. Measured on this lane's fixtures the
 * host produces 70.3 MiB/s of JSON while real xterm applies 2.2 MiB/s, so a 4 MiB window closes in
 * 62 ms — before the first frame is painted, not after a page has gone wrong.
 *
 * So output is held, merged, and delivered as the page acks, and the stream ends only on the two
 * things that are not slowness: a page that has stopped answering at all, and a backlog past what
 * this process can hold.
 */

/**
 * How long the page may ack nothing before the stream is called dead.
 *
 * Derived from the drain, not chosen: the window the page works against is 4 MiB and real xterm
 * applies 2.2 MiB/s, so clearing a full one takes about 1.9 s. This is an order of magnitude above
 * that, which is the difference between a page that is slow — a big paste, a backgrounded tab, a
 * GC pause — and one that is not running. Below that margin the rule would end streams that were
 * about to recover, which is the failure it exists to stop.
 */
export const TERMINAL_STREAM_ACK_SILENCE_MS = 20_000

/**
 * The most held output the shell will carry for one terminal.
 *
 * Bounded by the process rather than by the protocol: this is a phone holding an xterm, a WebView
 * and the app beside it, and an unbounded backlog is the native queue growth the window was added
 * to stop. At the measured 2.2 MiB/s drain this is about 15 s of catching up, which lands inside
 * the silence bound above — so a page that is merely slow is limited by its own reading, and a
 * page that is gone is ended by the clock rather than by how fast its terminal happened to print.
 */
export const TERMINAL_STREAM_MAX_PENDING_BYTES = 32 * 1024 * 1024

/** Why a held stream ended. Both reach the page as `overflow`; this is what the log says. */
export type TerminalBacklogEnd = 'ack-silence' | 'pending-ceiling'

/** Only this method's streams are held; every other one keeps the byte window exactly. */
export const TERMINAL_STREAM_METHOD = 'terminal.subscribe'

export function holdsTerminalOutput(method: string): boolean {
  return method === TERMINAL_STREAM_METHOD
}

/** The timer this backlog arms, injected so a test drives the clock rather than waiting on it. */
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

/**
 * An output payload, read rather than asserted.
 *
 * Only this shape merges. Everything else on a terminal stream — the scrollback snapshot, a resize,
 * a metadata frame, the subscribe acknowledgement — carries state the reader applies in order and
 * cannot be concatenated with anything, so it is held whole and keeps its place in the queue.
 */
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

/** What an output payload costs as JSON, which is what a frame is measured in. */
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

/**
 * One terminal stream's held output, in order, with the two ways it can stop being held.
 *
 * Drop-free by construction: nothing here removes an entry that was not handed to the caller, and
 * merging concatenates rather than chooses. The only exit that loses bytes is ending the stream,
 * which the page is told about and can resubscribe from.
 *
 * One subscription's, which is why the merge run below compares no stream ids: every `data`
 * payload reaching a backlog carries that subscription's single stream id, and a change that
 * multiplexed two streams onto one record would merge their output into one payload under the
 * first one's id.
 */
export class BridgeTerminalOutputBacklog {
  private readonly queue: Held[] = []
  private pending = 0
  private peak = 0
  private merged = 0
  private frames = 0
  private silence: unknown = null

  constructor(
    private readonly options: {
      /** Called once, when the page has answered nothing for the silence bound. */
      onAckSilence: () => void
      timers?: TerminalBacklogTimers
    }
  ) {}

  get pendingBytes(): number {
    return this.pending
  }

  /** The high-water mark, which is what says whether a stream was ever close to the ceiling. */
  get peakPendingBytes(): number {
    return this.peak
  }

  /** Frames the page never had to read because their bytes went out inside another one. */
  get coalescedFrames(): number {
    return this.merged
  }

  /** Frames this backlog handed back, which with the above is the ratio a device proof reads. */
  get deliveredFrames(): number {
    return this.frames
  }

  get held(): boolean {
    return this.queue.length > 0
  }

  /**
   * Hold a payload the page cannot be sent right now. False means the ceiling was reached.
   *
   * The payload that broke the ceiling is held anyway: the caller ends the stream on a false, and
   * an entry dropped on the way out would make this the one place the drop-free rule is untrue.
   */
  hold(payload: unknown): boolean {
    const output = readTerminalOutput(payload)
    if (output === null) {
      // Serialized in full, because a payload this module does not model has no cheaper size.
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

  /**
   * The next payload to send, merged as far as `allowedBytes` allows, or null for "not yet".
   *
   * `allowedBytes` is what one payload may occupy, which the caller narrows to the smaller of the
   * window's room and one frame; this used to narrow it to the frame a second time, which no input
   * could reach because the only caller had already done it.
   *
   * Null when the head does not fit is a wait, not a refusal: the caller comes back on the next ack
   * with a wider window. A head that cannot fit even an empty window is handed over regardless —
   * there is no later ack that would make room, and the ledger's own cap check is what decides
   * whether a single payload that large ends the stream.
   */
  next(allowedBytes: number, windowEmpty: boolean): unknown | null {
    const head = this.queue[0]
    if (head === undefined) {
      return null
    }
    if (head.bytes > allowedBytes && !windowEmpty) {
      return null
    }
    this.queue.shift()
    this.take(head.bytes)
    this.frames += 1
    if (head.kind === 'other') {
      this.syncSilence()
      return head.payload
    }
    let chunk = head.chunk
    // Consecutive output only: anything else in between is state the reader applies in order, and
    // merging across it would deliver bytes out of order. Nothing compares stream ids here, because
    // a backlog belongs to one subscription and every `data` payload on it carries that
    // subscription's single stream id; the comparison that used to be here could not fail.
    while (this.queue.length > 0) {
      const nextHeld = this.queue[0]
      if (nextHeld.kind !== 'output') {
        break
      }
      if (outputPayloadBytes(head.streamId, chunk + nextHeld.chunk) > allowedBytes) {
        break
      }
      this.queue.shift()
      this.take(nextHeld.bytes)
      chunk += nextHeld.chunk
      this.merged += 1
    }
    this.syncSilence()
    return { type: 'data', streamId: head.streamId, chunk }
  }

  /** The page answered, so the silence clock starts again from here. */
  noteAck(): void {
    this.clearSilence()
    this.syncSilence()
  }

  dispose(): void {
    this.clearSilence()
    this.queue.length = 0
    this.pending = 0
  }

  private add(bytes: number): void {
    this.pending += bytes
    this.peak = Math.max(this.peak, this.pending)
  }

  private take(bytes: number): void {
    this.pending = Math.max(0, this.pending - bytes)
  }

  /**
   * Armed exactly while something is pending, checked after every change to the queue.
   *
   * The invariant is "armed implies waiting on the page", and the first round broke it in one
   * direction only: an ack re-armed the clock and the drain that followed emptied the queue without
   * clearing it, so a terminal that had delivered everything and gone quiet died on `overflow`
   * twenty seconds later. A rule that only arms is a rule that only ever kills more.
   */
  private syncSilence(): void {
    if (this.queue.length === 0) {
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

/**
 * The escaped payload bytes one event frame can carry on a stream with this id.
 *
 * Derived from the cap and the envelope the shell really writes, rather than written down: a merge
 * past this produces a frame the page's own reader refuses, which is the hole that holding the
 * bytes exists to avoid. `seq` at its widest and the real id, because both are in every frame.
 */
export function terminalStreamMaxPayloadBytes(id: string): number {
  return BRIDGE_MAX_MESSAGE_BYTES - bridgeEventEnvelopeBytes(id)
}

/**
 * Send as much held output as the page has made room for, merged as far as one frame allows.
 *
 * Bounded by the window rather than by a count: each pass re-reads it, so a page that acked one
 * frame gets one frame back and a page that acked a megabyte gets a megabyte. An empty window is
 * what lets the head through regardless of its size — there is no later ack that would make more
 * room than none owed, and the caller's own cap check is what decides whether a single payload that
 * large ends the stream under C0.3.
 *
 * Written against the ledger's four questions rather than inside it: what the shell does with held
 * terminal output is this module's rule, and what a frame costs and whether it retired the stream
 * is the ledger's.
 */
export function drainTerminalBacklog(deps: {
  backlog: BridgeTerminalOutputBacklog
  maxPayloadBytes: number
  windowHasRoom: () => boolean
  /** What the window has left for a payload right now, read again on every pass. */
  availableWindowBytes: () => number
  /** True when the page owes nothing, which is what lets an oversized head through. */
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
