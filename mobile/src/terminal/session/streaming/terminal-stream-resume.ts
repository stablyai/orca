type TerminalResumePosition = { streamToken: string; units: number }

/**
 * Where each mounted xterm stopped on its last credited stream, and which terminals still wait for their catch-up.
 * A document that loses its buffer (reload, remount, iOS foreground repaint, cache clear) must be forgotten.
 */
export class TerminalResumeState {
  private readonly positions = new Map<string, TerminalResumePosition>()
  private readonly catchingUp = new Set<string>()
  // Live streams whose position would be kept if they stopped now.
  private readonly resumable = new Set<string>()
  private readonly listeners = new Set<() => void>()

  take(handle: string): TerminalResumePosition | null {
    const position = this.positions.get(handle) ?? null
    this.positions.delete(handle)
    return position
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

  /** Whether a live stream on `handle` would resume after a cancel, so cancelling it costs no snapshot. */
  canResume(handle: string): boolean {
    return this.resumable.has(handle)
  }

  setResumable(handle: string, resumable: boolean): void {
    if (resumable) {
      this.resumable.add(handle)
    } else {
      this.resumable.delete(handle)
    }
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
  // Only a credited stream into a rendered xterm resumes: the host records positions only for those.
  canResume: boolean
) {
  const resume = canResume ? state.take(handle) : null
  let streamToken: string | null = null
  let streamId: unknown
  let applying = false
  let units = 0
  const setToken = (token: string | null) => {
    streamToken = token
    state.setResumable(handle, token !== null)
  }
  state.setCatchingUp(handle, resume !== null)
  return {
    params: resume ? { resume } : {},
    /** True when the host resumed: the xterm already shows everything before the output that follows. */
    subscribed(reply: Record<string, unknown>): boolean {
      setToken(
        reply.outputAck === true && typeof reply.streamToken === 'string' ? reply.streamToken : null
      )
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
        setToken(null)
        return
      }
      units += event.chunk.length
    },
    /** A mid-stream snapshot redraws the xterm, and the host stops recording this stream for resume. */
    invalidate(): void {
      setToken(null)
    },
    ended(type: 'end' | 'error'): void {
      // An error can follow output the transport dropped, so the count may skip a frame the xterm never got.
      if (type === 'error') {
        setToken(null)
      }
    },
    /** Keeps the position for the next subscribe when the xterm still shows this stream's output. */
    stop(stillShown: boolean): void {
      state.setCatchingUp(handle, false)
      if (applying && streamToken !== null && stillShown) {
        state.save(handle, { streamToken, units })
      }
      setToken(null)
    }
  }
}
