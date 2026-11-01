// Unit 4: maps decoded terminal-stream frames into TerminalTailSlice (spec S8).
// Decoupled from Unit 3's concrete TerminalTailDecoder: accepts a minimal TailDecoder via
// constructor injection. Unit 8 (integrator) passes the real decoder instance.
//
// v1 is binary-only: terminal.subscribe is asked for capabilities.terminalBinaryStream so the
// host streams TerminalStreamFrame bytes (terminal-subscribe-method.ts:27 gates on this exact
// flag). Hosts that don't honor it fall back to JSON terminal events instead, which this
// decoder cannot render — full JSON terminal decoding is out of scope for v1 (tracked for v2).
// Rather than show a blank tail, that case (detected via the JSON `data` fallback event, or a
// binary-silence timeout) flips terminalTail.unavailable so screens can say so explicitly.
import {
  decodeTerminalStreamFrame,
  TerminalStreamOpcode,
  type TerminalStreamFrame
} from '@orca-shared/terminal-stream-protocol'
import type { HudStore } from './hud-store'
import type { RpcPort } from '../transport/orca-rpc-wire'

// Finding: while the wearer is browsing history on the terminal-tail screen (frame.page !== 0),
// terminal-tail-screen.ts paginates against `state.terminalTail.lines`, which keeps growing as
// output arrives — so the offset-from-latest page identity shifts underfoot mid-read. This
// freezes the line snapshot paginated while browsing (captured the moment page leaves 0) so
// appended output doesn't move the current view; returning to page 0 drops the freeze so live
// output resumes immediately (no need to wait for the next frame).
export class TerminalTailBrowseFreeze {
  private snapshot: { terminalId: string; lines: string[] } | null = null

  /** Lines terminal-tail-screen.ts should paginate for this render. */
  resolve(terminalId: string, liveLines: string[], page: number): string[] {
    if (page === 0) {
      this.snapshot = null
      return liveLines
    }
    if (!this.snapshot || this.snapshot.terminalId !== terminalId) {
      this.snapshot = { terminalId, lines: liveLines }
    }
    return this.snapshot.lines
  }

  /** Test hook: clears the freeze so cases don't leak into each other. */
  reset(): void {
    this.snapshot = null
  }
}

// Single shared instance: only one terminal-tail screen is ever visible at a time, mirroring
// TerminalTailController's single-active-subscription design above.
export const terminalTailBrowseFreeze = new TerminalTailBrowseFreeze()

export type TailDecoder = {
  pushFrame(frame: TerminalStreamFrame): void
  lines(): string[]
}

/** Injectable timer so tests can drive the binary-silence timeout deterministically. */
export type TailTimer = {
  setTimeout(cb: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type TerminalTailInputs = {
  port: RpcPort
  createDecoder(): TailDecoder
  viewport?: { cols: number; rows: number }
  timer?: TailTimer
  /** How long to wait for a first binary frame before declaring the stream unavailable. */
  unavailableTimeoutMs?: number
}

const DEFAULT_VIEWPORT = { cols: 60, rows: 20 }
const DEFAULT_UNAVAILABLE_TIMEOUT_MS = 2000

const REAL_TAIL_TIMER: TailTimer = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/** Emitted only by the host's JSON (non-binary) terminal.subscribe fallback path — a definitive
 *  "this host isn't giving us binary frames" signal (terminal-legacy-simple-subscriptions.ts). */
function isJsonFallbackDataEvent(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'data'
  )
}

/** Opens/closes a terminal.subscribe stream and keeps store.terminalTail in sync. */
export class TerminalTailController {
  private readonly timer: TailTimer
  private readonly unavailableTimeoutMs: number
  private unsubscribe: (() => void) | null = null
  private activeTerminalId: string | null = null
  private unavailableTimeoutHandle: unknown = null

  constructor(
    private readonly store: HudStore,
    private readonly inputs: TerminalTailInputs
  ) {
    this.timer = inputs.timer ?? REAL_TAIL_TIMER
    this.unavailableTimeoutMs = inputs.unavailableTimeoutMs ?? DEFAULT_UNAVAILABLE_TIMEOUT_MS
  }

  open(terminalId: string): void {
    this.close()
    this.activeTerminalId = terminalId
    const decoder = this.inputs.createDecoder()

    // Finding #4: loading:true from open() until the first frame decodes (or unavailable fires)
    // so the screen can render "Loading terminal…" instead of a blank body during that window.
    this.store.update((s) => ({
      ...s,
      terminalTail: { terminalId, lines: [], live: true, loading: true }
    }))

    this.unsubscribe = this.inputs.port.subscribe(
      'terminal.subscribe',
      {
        terminal: terminalId,
        viewport: this.inputs.viewport ?? DEFAULT_VIEWPORT,
        capabilities: { terminalBinaryStream: 1 }
      },
      (data) => this.handleJson(terminalId, data),
      (payload) => this.handleBinary(terminalId, decoder, payload)
    )
    this.unavailableTimeoutHandle = this.timer.setTimeout(
      () => this.markUnavailable(terminalId),
      this.unavailableTimeoutMs
    )
  }

  close(): void {
    this.clearUnavailableTimeout()
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    this.activeTerminalId = null
    this.store.update((s) =>
      s.terminalTail.terminalId === null
        ? s
        : { ...s, terminalTail: { terminalId: null, lines: [], live: false } }
    )
  }

  /** JSON side-channel: unused for content in v1, except as the non-binary-host tell. */
  private handleJson(terminalId: string, data: unknown): void {
    if (this.activeTerminalId !== terminalId) {
      return
    }
    if (isJsonFallbackDataEvent(data)) {
      this.markUnavailable(terminalId)
    }
  }

  private handleBinary(terminalId: string, decoder: TailDecoder, payload: Uint8Array): void {
    if (this.activeTerminalId !== terminalId) {
      return
    } // subscription superseded by a later open()/close()
    const frame = decodeTerminalStreamFrame(payload)
    if (!frame) {
      return
    }
    this.clearUnavailableTimeout() // a real binary frame proves the host supports the stream
    decoder.pushFrame(frame)
    const live = frame.opcode !== TerminalStreamOpcode.Error
    this.store.update((s) =>
      s.terminalTail.terminalId === terminalId
        ? {
            ...s,
            terminalTail: {
              terminalId,
              lines: decoder.lines(),
              live,
              unavailable: false,
              loading: false
            }
          }
        : s
    )
  }

  /** No binary ever arrived (silent timeout, or a JSON fallback event) — host can't stream binary. */
  private markUnavailable(terminalId: string): void {
    this.clearUnavailableTimeout()
    if (this.activeTerminalId !== terminalId) {
      return
    }
    this.store.update((s) =>
      s.terminalTail.terminalId === terminalId
        ? {
            ...s,
            terminalTail: { terminalId, lines: [], live: false, unavailable: true, loading: false }
          }
        : s
    )
  }

  private clearUnavailableTimeout(): void {
    if (this.unavailableTimeoutHandle !== null) {
      this.timer.clearTimeout(this.unavailableTimeoutHandle)
      this.unavailableTimeoutHandle = null
    }
  }
}
