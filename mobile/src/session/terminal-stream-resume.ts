import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'

type TerminalResumePosition = {
  terminal: TerminalWebViewHandle
  streamToken: string
  units: number
}

/** Where each mounted xterm stopped on its last credited stream, and which terminals still wait for their catch-up. */
export class TerminalResumeState {
  private readonly positions = new Map<string, TerminalResumePosition>()
  private readonly catchingUp = new Set<string>()
  private readonly listeners = new Set<() => void>()

  /** Takes the handle's position for a subscribe into `terminal`; a replaced document no longer shows it. */
  take(handle: string, terminal: TerminalWebViewHandle) {
    const position = this.positions.get(handle)
    this.positions.delete(handle)
    return position && position.terminal === terminal
      ? { streamToken: position.streamToken, units: position.units }
      : null
  }

  save(handle: string, position: TerminalResumePosition): void {
    this.positions.set(handle, position)
  }

  /** The xterm lost what it showed (document reload, iOS foreground repaint, cache clear). */
  forget(handle?: string): void {
    if (handle === undefined) {
      this.positions.clear()
    } else {
      this.positions.delete(handle)
    }
  }

  holdsAny(): boolean {
    return this.positions.size > 0
  }

  isCatchingUp(handle: string): boolean {
    return this.catchingUp.has(handle)
  }

  setCatchingUp(handle: string, active: boolean): void {
    if (active === this.catchingUp.has(handle)) {
      return
    }
    if (active) {
      this.catchingUp.add(handle)
    } else {
      this.catchingUp.delete(handle)
    }
    this.notify()
  }

  // For useSyncExternalStore, so only the header re-renders when a catch-up starts or ends.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  anyCatchingUp = (): boolean => this.catchingUp.size > 0

  private notify(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }
}

/**
 * One subscription's resume cursor: Output units (UTF-16, as received) the xterm applied on the stream its
 * `subscribed` reply named, counted after that stream's snapshot or from its `resumed` reply.
 */
export function createTerminalStreamResumeCursor(
  state: TerminalResumeState,
  handle: string,
  // The xterm a credited subscription writes into; undefined never resumes.
  terminal: TerminalWebViewHandle | undefined
) {
  const resume = terminal ? state.take(handle, terminal) : null
  let streamToken: string | null = null
  let streamId: unknown
  let applying = false
  let units = 0
  state.setCatchingUp(handle, resume !== null)
  return {
    params: resume ? { resume } : {},
    /** True when the host resumed: the xterm already shows everything before the output that follows. */
    subscribed(reply: Record<string, unknown>): boolean {
      streamToken =
        reply.outputAck === true && typeof reply.streamToken === 'string' ? reply.streamToken : null
      streamId = reply.streamId
      units = 0
      applying = resume !== null && reply.resumed === true
      if (applying) {
        state.setCatchingUp(handle, false)
      }
      return applying
    },
    snapshotApplied(snapshotStreamId: unknown): void {
      if (snapshotStreamId === streamId) {
        applying = true
        units = 0
      }
      state.setCatchingUp(handle, false)
    },
    output(event: Record<string, unknown>, written: boolean): void {
      // Output before this stream's snapshot is replaced by it.
      if (!applying) {
        return
      }
      // A hole or a foreign stream's output means the xterm no longer matches any count the host recorded.
      if (!written || event.streamId !== streamId || typeof event.chunk !== 'string') {
        streamToken = null
        return
      }
      units += event.chunk.length
    },
    /** A mid-stream snapshot redraws the xterm, and the host stops recording this stream for resume. */
    invalidate(): void {
      streamToken = null
    },
    /** Keeps the position for the next subscribe when `terminal` still shows this stream's output. */
    stop(terminal: TerminalWebViewHandle | undefined): void {
      state.setCatchingUp(handle, false)
      if (applying && streamToken !== null && terminal) {
        state.save(handle, { terminal, streamToken, units })
      }
    }
  }
}
