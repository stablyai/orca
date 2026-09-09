import { MAX_TAIL_CHARS } from './terminal-tail-limits'
import type { TerminalTailWaitState } from './terminal-wait-tail-state'

/**
 * The capped rolling window of output appended since the last wait-blocked scan.
 *
 * Why chunks instead of one string: the scan is throttled to 50ms but the
 * accumulation is per chunk, so concatenating and re-slicing a 256KB window on
 * every PTY frame flattened the whole window per frame once a burst filled it.
 * Chunks are retained with a running char count and joined once, at scan time.
 */
export type WaitBlockedAppendedCarry = {
  chunks: string[]
  chars: number
}

export type WaitBlockedCheckState = {
  lastAt: number
  lastWaitState: TerminalTailWaitState | null
  appended: WaitBlockedAppendedCarry
  keywordCarry: string
  timer: ReturnType<typeof setTimeout> | null
}

export function createWaitBlockedAppendedCarry(): WaitBlockedAppendedCarry {
  return { chunks: [], chars: 0 }
}

export function createWaitBlockedCheckState(): WaitBlockedCheckState {
  return {
    lastAt: 0,
    lastWaitState: null,
    appended: createWaitBlockedAppendedCarry(),
    keywordCarry: '',
    timer: null
  }
}

/**
 * Appends one chunk, dropping from the head past `MAX_TAIL_CHARS`. The cap keeps
 * the tail: the accumulated text only anchors boundary-spanning prompt detection,
 * and anything past the tail cap has scrolled out of the retained tail the check
 * reads anyway. Byte-for-byte identical to `(previous + chunk).slice(-cap)`,
 * including the partial trim of the chunk that straddles the cap boundary.
 */
export function appendWaitBlockedCarry(carry: WaitBlockedAppendedCarry, chunk: string): void {
  if (chunk.length === 0) {
    return
  }
  carry.chunks.push(chunk)
  carry.chars += chunk.length
  if (carry.chars <= MAX_TAIL_CHARS) {
    return
  }
  let excess = carry.chars - MAX_TAIL_CHARS
  let dropCount = 0
  while (excess > 0 && dropCount < carry.chunks.length) {
    const head = carry.chunks[dropCount]
    if (head.length <= excess) {
      excess -= head.length
      dropCount += 1
      continue
    }
    carry.chunks[dropCount] = head.slice(excess)
    excess = 0
  }
  if (dropCount > 0) {
    carry.chunks.splice(0, dropCount)
  }
  carry.chars = MAX_TAIL_CHARS
}

export function readWaitBlockedCarry(carry: WaitBlockedAppendedCarry): string {
  return carry.chunks.length === 1 ? carry.chunks[0] : carry.chunks.join('')
}

export function resetWaitBlockedCarry(carry: WaitBlockedAppendedCarry): void {
  carry.chunks.length = 0
  carry.chars = 0
}
