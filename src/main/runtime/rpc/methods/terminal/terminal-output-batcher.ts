import type { TerminalOutputMeta } from '../../terminal-output-frame-chunks'
import { TERMINAL_OUTPUT_BATCH_MAX_BYTES } from '../../../../../shared/terminal-multiplex-flow-control'
import { measureTerminalStreamByteLength } from '../../terminal-stream-byte-length'
import {
  sameTerminalOutputSourceIdentity,
  type TerminalOutputSourceRange
} from '../../../../../shared/terminal-output-source-range'

const TERMINAL_OUTPUT_FLUSH_MS = 5
export type TerminalOutputBatcher = {
  push: (data: string, meta?: TerminalOutputMeta) => void
  flush: () => void
  dispose: () => void
}

export function createTerminalOutputBatcher(
  onFlush: (data: string, meta?: TerminalOutputMeta) => void
): TerminalOutputBatcher {
  let chunks: string[] = []
  let bytes = 0
  let lastSeq: number | undefined
  let pendingCwd: string | undefined
  let pendingRawLength = 0
  let pendingSourceRanges: TerminalOutputSourceRange[] = []
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
      typeof lastSeq === 'number' || pendingCwd !== undefined || pendingSourceRanges.length > 0
        ? {
            ...(typeof lastSeq === 'number' ? { seq: lastSeq, rawLength: pendingRawLength } : {}),
            ...(pendingCwd !== undefined ? { cwd: pendingCwd } : {}),
            ...(pendingSourceRanges.length > 0
              ? { sourceRanges: Object.freeze(pendingSourceRanges.slice()) }
              : {})
          }
        : undefined
    chunks = []
    bytes = 0
    lastSeq = undefined
    pendingCwd = undefined
    pendingRawLength = 0
    pendingSourceRanges = []
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
      const nextSourceRanges = meta?.sourceRanges ?? []
      const lastSourceRange = pendingSourceRanges.at(-1)
      const firstNextSourceRange = nextSourceRanges[0]
      if (
        chunks.length > 0 &&
        (pendingSourceRanges.length > 0 !== nextSourceRanges.length > 0 ||
          (lastSourceRange &&
            firstNextSourceRange &&
            (!sameTerminalOutputSourceIdentity(lastSourceRange, firstNextSourceRange) ||
              lastSourceRange.displayEnd !== firstNextSourceRange.displayStart)))
      ) {
        flush()
      }
      if (meta?.cwd !== undefined) {
        flush()
        pendingCwd = meta.cwd
      }
      chunks.push(data)
      pendingRawLength += rawLength
      pendingSourceRanges.push(...nextSourceRanges)
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
        // Why: coalesce stream output before it crosses the network; desktop subscribers share the same burst boundary.
        timer = setTimeout(flush, TERMINAL_OUTPUT_FLUSH_MS)
        if (typeof timer.unref === 'function') {
          timer.unref()
        }
      }
    },
    flush,
    dispose(): void {
      clearTimer()
      chunks = []
      bytes = 0
      pendingRawLength = 0
      pendingSourceRanges = []
    }
  }
}
