import { Buffer } from 'node:buffer'
import type {
  HerdrTerminalController,
  HerdrTerminalClosed,
  HerdrTerminalControlOptions,
  HerdrTerminalFrame
} from './herdr-runtime-contract'
import type { HerdrSocketEvent, PaneReadWireResponse, PaneResizeResult } from './herdr-socket-types'

export type HerdrSocketTerminalDeps = {
  request<T>(method: string, params: unknown): Promise<T>
  subscribeEvents(listener: (event: HerdrSocketEvent) => void): () => void
  timeoutMs?: number
}

const FRAME_POLL_INTERVAL_MS = 150

// Synthesize the herdr terminal.frame surface from socket primitives: there is
// no ANSI frame stream over the socket, so frames are pane.read snapshots
// (format ansi) diffed by text, pumped on a poll backstop. The stock server
// never advances read revision and has no pane_output_changed event, so
// revision-based dedup would freeze output after the first frame.
// write -> pane.send_input, resize -> absolute via the pane.layout rect +
// relative pane.resize, closed -> pane_exited.
export function createHerdrSocketTerminalController(
  paneId: string,
  options: HerdrTerminalControlOptions,
  deps: HerdrSocketTerminalDeps
): HerdrTerminalController {
  const frameListeners = new Set<(frame: HerdrTerminalFrame) => void>()
  const closedListeners = new Set<(event: HerdrTerminalClosed) => void>()
  const pendingFrames: HerdrTerminalFrame[] = []
  let pendingClosed: HerdrTerminalClosed | null = null
  let cols = options.cols
  let rows = options.rows
  let lastText: string | null = null
  let seq = 0
  let released = false
  let inFlight = false

  const emitFrame = (frame: HerdrTerminalFrame): void => {
    if (frameListeners.size === 0) {
      pendingFrames.push(frame)
      if (pendingFrames.length > 512) {
        pendingFrames.shift()
      }
      return
    }
    for (const listener of frameListeners) {
      listener(frame)
    }
  }

  const emitClosed = (event: HerdrTerminalClosed): void => {
    if (closedListeners.size === 0) {
      pendingClosed = event
      return
    }
    for (const listener of closedListeners) {
      listener(event)
    }
  }

  const readFrame = async (): Promise<void> => {
    if (released || inFlight) {
      return
    }
    inFlight = true
    try {
      const wire = await deps.request<PaneReadWireResponse>('pane.read', {
        pane_id: paneId,
        format: 'ansi',
        source: 'visible'
      })
      const result = wire.read
      if (released || result.text === lastText) {
        return
      }
      lastText = result.text
      seq += 1
      emitFrame({
        type: 'terminal.frame',
        seq,
        encoding: 'ansi',
        width: cols,
        height: rows,
        full: true,
        bytes: Buffer.from(result.text, 'utf8').toString('base64')
      })
    } catch {
      // pane may be mid-teardown; the pane_exited event emits the close.
    } finally {
      inFlight = false
    }
  }

  const unsubscribe = deps.subscribeEvents((event) => {
    if (released) {
      return
    }
    if (event.event === 'pane.exited' && (event.data as { pane_id?: string })?.pane_id === paneId) {
      emitClosed({ type: 'terminal.closed', reason: 'pane_exited' })
    }
  })

  const pollTimer = setInterval(() => {
    void readFrame()
  }, FRAME_POLL_INTERVAL_MS)

  const resize = (nextCols: number, nextRows: number): void => {
    cols = nextCols
    rows = nextRows
    if (released) {
      return
    }
    // Why: the daemon applies absolute sizes; the relative layout-delta path
    // below was unreachable because pane.layout rects are static.
    void deps
      .request<PaneResizeResult>('pane.resize', {
        pane_id: paneId,
        cols: nextCols,
        rows: nextRows
      })
      .catch(() => undefined)
  }

  void readFrame()

  return {
    write: (data) => {
      if (released) {
        return
      }
      void deps.request('pane.send_input', { pane_id: paneId, text: data }).catch(() => undefined)
    },
    resize,
    release: () => {
      if (released) {
        return
      }
      released = true
      clearInterval(pollTimer)
      unsubscribe()
    },
    onFrame: (listener) => {
      frameListeners.add(listener)
      for (const frame of pendingFrames.splice(0)) {
        listener(frame)
      }
      return () => frameListeners.delete(listener)
    },
    onClosed: (listener) => {
      closedListeners.add(listener)
      if (pendingClosed) {
        listener(pendingClosed)
        pendingClosed = null
      }
      return () => closedListeners.delete(listener)
    }
  }
}
