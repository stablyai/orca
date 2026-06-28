import type { RuntimeTerminalRead, RuntimeTerminalReadAnsi } from '../../shared/runtime-types'
import type { TuiRpcClient } from './tui-rpc-client'

const DEFAULT_INTERVAL_MS = 120
const PLAIN_TAIL_LIMIT = 500
/** Scrollback lines to serialize alongside the visible screen, so the viewport
 *  can show recent history (and fill a pane taller than the live screen). */
const SCROLLBACK_ROWS = 1000

/** The focused terminal's latest output, kept raw so the compositor can paint
 *  the runtime's serialized ANSI VERBATIM (byte-for-byte) into the viewport.
 *  `data` is the full SGR screen serialization from terminal.readAnsi; when the
 *  runtime can't serialize ANSI we fall back to the plain-text tail. */
export type TerminalAnsiFrame = {
  /** Serialized ANSI+SGR screen (SerializeAddon output), or null on fallback. */
  data: string | null
  cols: number
  rows: number
  /** Plain-text tail lines, used only when `data` is null. */
  plainLines: string[]
  connected: boolean
  plainFallback: boolean
  /** True once the runtime has rejected terminal.readAnsi as unknown — i.e. it
   *  predates the method, so the verbatim screen is unavailable until it's
   *  rebuilt. Lets the viewport explain the empty pane instead of misleading. */
  ansiUnsupported?: boolean
}

export function emptyAnsiFrame(): TerminalAnsiFrame {
  return { data: null, cols: 0, rows: 0, plainLines: [], connected: false, plainFallback: false }
}

export type TerminalAnsiSourceOptions = {
  intervalMs?: number
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

/** True for an error meaning the runtime doesn't know terminal.readAnsi (an
 *  older runtime not yet rebuilt) — so we stop trying it and use plain text. */
function looksLikeUnknownMethod(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return (
    message.includes('unknown command') ||
    message.includes('unknown method') ||
    message.includes('not supported') ||
    message.includes('not_supported') ||
    message.includes('method not found') ||
    message.includes('method_not_found') ||
    message.includes('no such method')
  )
}

/** Polls the focused terminal's serialized ANSI screen. Local Unix-socket RPC
 *  is single-reply (no push), so we poll fast and the compositor diffs frames
 *  to avoid flicker. */
export class TerminalAnsiSource {
  private readonly client: TuiRpcClient
  private readonly handle: string
  private readonly intervalMs: number
  private readonly setTimer: NonNullable<TerminalAnsiSourceOptions['setTimer']>
  private readonly clearTimer: NonNullable<TerminalAnsiSourceOptions['clearTimer']>

  private frame: TerminalAnsiFrame = emptyAnsiFrame()
  private ansiSupported = true
  private readonly listeners = new Set<(frame: TerminalAnsiFrame) => void>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false

  constructor(client: TuiRpcClient, handle: string, options: TerminalAnsiSourceOptions = {}) {
    this.client = client
    this.handle = handle
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
  }

  getFrame(): TerminalAnsiFrame {
    return this.frame
  }

  subscribe(listener: (frame: TerminalAnsiFrame) => void): () => void {
    this.listeners.add(listener)
    listener(this.frame)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async refreshOnce(): Promise<void> {
    if (this.ansiSupported) {
      try {
        const { result } = await this.client.call<{ terminal: RuntimeTerminalReadAnsi }>(
          'terminal.readAnsi',
          { terminal: this.handle, scrollbackRows: SCROLLBACK_ROWS }
        )
        const snapshot = result.terminal
        if (snapshot) {
          this.emit({
            data: snapshot.data,
            cols: snapshot.cols,
            rows: snapshot.rows,
            plainLines: [],
            connected: true,
            plainFallback: false
          })
          return
        }
        // No active PTY snapshot yet — fall through to the plain tail.
      } catch (error) {
        // A clear unknown-method error means the runtime predates readAnsi;
        // stop trying. Any other error still falls through to the plain tail
        // this tick (so the panel always shows output) and retries ANSI next.
        if (looksLikeUnknownMethod(error)) {
          this.ansiSupported = false
        }
      }
    }
    await this.refreshPlain()
  }

  private async refreshPlain(): Promise<void> {
    try {
      const { result } = await this.client.call<{ terminal: RuntimeTerminalRead }>(
        'terminal.read',
        {
          terminal: this.handle,
          limit: PLAIN_TAIL_LIMIT
        }
      )
      this.emit({
        data: null,
        cols: 0,
        rows: 0,
        plainLines: result.terminal.tail,
        connected: true,
        plainFallback: true,
        ansiUnsupported: !this.ansiSupported
      })
    } catch {
      this.emit({ ...this.frame, connected: false })
    }
  }

  start(): void {
    if (this.running) {
      return
    }
    this.running = true
    void this.tick()
  }

  stop(): void {
    this.running = false
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) {
      return
    }
    await this.refreshOnce()
    if (!this.running) {
      return
    }
    this.timer = this.setTimer(() => void this.tick(), this.intervalMs)
  }

  private emit(next: TerminalAnsiFrame): void {
    this.frame = next
    for (const listener of this.listeners) {
      listener(next)
    }
  }
}
