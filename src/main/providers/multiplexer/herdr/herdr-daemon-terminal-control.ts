import { Buffer } from 'node:buffer'
import type {
  HerdrTerminalController,
  HerdrTerminalClosed,
  HerdrTerminalControlOptions,
  HerdrTerminalFrame
} from './herdr-runtime-contract'
import type { HerdrSocketEvent, PaneReadWireResponse } from './herdr-socket-types'

export type HerdrDaemonPaneData = {
  pane_id: string
  data: string
  sequence_chars: number
}

export type HerdrDaemonTerminalDeps = {
  request<T>(method: string, params: unknown): Promise<T>
  subscribePaneData(listener: (payload: HerdrDaemonPaneData) => void): () => void
  subscribeEvents(listener: (event: HerdrSocketEvent) => void): () => void
}

// Why: the in-app daemon owns the PTY and pushes raw bytes as pane.data
// notifications, so the controller seeds the screen from one pane.read and then
// streams incremental frames. Polling pane.read and text-diffing snapshots (the
// socket path) re-emits the whole window whenever a shell redraws in place
// (zsh/zle), duplicating the prompt and displacing the input line.
export function createHerdrDaemonTerminalController(
  paneId: string,
  options: HerdrTerminalControlOptions,
  deps: HerdrDaemonTerminalDeps
): HerdrTerminalController {
  const frameListeners = new Set<(frame: HerdrTerminalFrame) => void>()
  const closedListeners = new Set<(event: HerdrTerminalClosed) => void>()
  const pendingFrames: HerdrTerminalFrame[] = []
  const buffered: HerdrDaemonPaneData[] = []
  let pendingClosed: HerdrTerminalClosed | null = null
  let cols = options.cols
  let rows = options.rows
  let seq = 0
  let released = false
  let seedRevision = -1
  let seedResolved = false

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

  const emitIncremental = (data: string): void => {
    if (released || !data) {
      return
    }
    seq += 1
    emitFrame({
      type: 'terminal.frame',
      seq,
      encoding: 'ansi',
      width: cols,
      height: rows,
      full: false,
      bytes: Buffer.from(data, 'utf8').toString('base64')
    })
  }

  const seed = async (): Promise<void> => {
    if (released) {
      return
    }
    try {
      const wire = await deps.request<PaneReadWireResponse>('pane.read', {
        pane_id: paneId,
        format: 'ansi',
        source: 'visible'
      })
      if (released) {
        return
      }
      seedRevision = wire.read.revision
      seq += 1
      emitFrame({
        type: 'terminal.frame',
        seq,
        encoding: 'ansi',
        width: cols,
        height: rows,
        full: true,
        bytes: Buffer.from(wire.read.text, 'utf8').toString('base64')
      })
    } catch {
      // Why: a failed read still emits an empty seed so the codec's first frame
      // is the snapshot; the pane.exited event tears the controller down.
      if (released) {
        return
      }
      seq += 1
      emitFrame({
        type: 'terminal.frame',
        seq,
        encoding: 'ansi',
        width: cols,
        height: rows,
        full: true,
        bytes: ''
      })
    } finally {
      seedResolved = true
    }
    for (const chunk of buffered.splice(0)) {
      if (chunk.sequence_chars > seedRevision) {
        emitIncremental(chunk.data)
      }
    }
  }

  const unsubscribePaneData = deps.subscribePaneData((payload) => {
    if (released || payload.pane_id !== paneId) {
      return
    }
    if (!seedResolved) {
      buffered.push(payload)
      return
    }
    if (payload.sequence_chars <= seedRevision) {
      return
    }
    emitIncremental(payload.data)
  })

  const unsubscribeEvents = deps.subscribeEvents((event) => {
    if (released) {
      return
    }
    if (event.event === 'pane.exited' && (event.data as { pane_id?: string })?.pane_id === paneId) {
      emitClosed({ type: 'terminal.closed', reason: 'pane_exited' })
    }
  })

  const resize = (nextCols: number, nextRows: number): void => {
    cols = nextCols
    rows = nextRows
    if (released) {
      return
    }
    void deps
      .request('pane.resize', { pane_id: paneId, cols: nextCols, rows: nextRows })
      .catch(() => undefined)
  }

  void seed()

  void deps.request('pane.focus', { pane_id: paneId }).catch(() => undefined)

  return {
    write: (data) => {
      if (released) {
        return
      }
      void deps.request('pane.send_text', { pane_id: paneId, text: data }).catch(() => undefined)
    },
    resize,
    release: () => {
      if (released) {
        return
      }
      released = true
      unsubscribePaneData()
      unsubscribeEvents()
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
