import type { TerminalOutputMeta } from '../../terminal/terminal-output-frame-chunks'
import {
  TERMINAL_OUTPUT_BATCH_MAX_BYTES,
  type TerminalOutputCadence
} from '../../../../../shared/terminal/stream/terminal-multiplex-flow-control'
import { measureTerminalStreamByteLength } from '../../terminal/terminal-stream-byte-length'

const TERMINAL_OUTPUT_FLUSH_MS: Record<TerminalOutputCadence, number> = {
  focused: 5,
  // Why: collapses several TUI repaints into one frame; ~20fps is still live for a peripheral pane.
  background: 50
}
export type TerminalOutputBatcher = {
  push: (data: string, meta?: TerminalOutputMeta) => void
  flush: () => void
  /** Switching to `focused` flushes pending output so the newly focused pane shows no lag. */
  setCadence: (cadence: TerminalOutputCadence) => void
  dispose: () => void
}

export function createTerminalOutputBatcher(
  onFlush: (data: string, meta?: TerminalOutputMeta) => void,
  initialCadence: TerminalOutputCadence = 'focused'
): TerminalOutputBatcher {
  let cadence = initialCadence
  let chunks: string[] = []
  let bytes = 0
  let lastSeq: number | undefined
  let pendingCwd: string | undefined
  let pendingRawLength = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = (): void => {
    if (!timer) {
      return
    }
    clearTimeout(timer)
    timer = null
  }

  const flush = (): void => {
    clearTimer()
    if (chunks.length === 0 && pendingRawLength === 0) {
      return
    }
    const data = chunks.length === 1 ? chunks[0]! : chunks.join('')
    const meta =
      typeof lastSeq === 'number' || pendingCwd !== undefined
        ? {
            ...(typeof lastSeq === 'number' ? { seq: lastSeq, rawLength: pendingRawLength } : {}),
            ...(pendingCwd !== undefined ? { cwd: pendingCwd } : {})
          }
        : undefined
    chunks = []
    bytes = 0
    lastSeq = undefined
    pendingCwd = undefined
    pendingRawLength = 0
    onFlush(data, meta)
  }

  return {
    push(data: string, meta?: TerminalOutputMeta): void {
      const rawLength = meta?.rawLength ?? data.length
      if (!data && rawLength === 0) {
        return
      }
      if (meta?.transformed || rawLength !== data.length) {
        flush()
        onFlush(data, { ...meta, rawLength, transformed: true })
        return
      }
      if (meta?.cwd !== undefined) {
        flush()
        pendingCwd = meta.cwd
      }
      chunks.push(data)
      pendingRawLength += rawLength
      const remainingBudget = Math.max(1, TERMINAL_OUTPUT_BATCH_MAX_BYTES - bytes)
      const measurement = measureTerminalStreamByteLength(data, {
        stopAfterBytes: remainingBudget
      })
      bytes += measurement.byteLength
      if (typeof meta?.seq === 'number') {
        lastSeq = meta.seq
      }
      if (measurement.exceededLimit || bytes >= TERMINAL_OUTPUT_BATCH_MAX_BYTES) {
        flush()
        return
      }
      if (!timer) {
        // Coalesce before network delivery; desktop subscribers share this burst boundary.
        timer = setTimeout(flush, TERMINAL_OUTPUT_FLUSH_MS[cadence])
        if (typeof timer.unref === 'function') {
          timer.unref()
        }
      }
    },
    flush,
    setCadence(next: TerminalOutputCadence): void {
      cadence = next
      if (next === 'focused') {
        flush()
      }
    },
    dispose(): void {
      clearTimer()
      chunks = []
      bytes = 0
      pendingRawLength = 0
    }
  }
}
