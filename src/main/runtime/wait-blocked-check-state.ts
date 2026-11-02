import { MAX_TAIL_CHARS } from './terminal-tail-limits'
import type { TerminalTailWaitState } from './terminal-wait-tail-state'

/** Retain chunks and join once per throttled scan; per-frame concatenation/slicing flattened the full 256KiB window after saturation. */
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

/** Keep exactly (previous + chunk).slice(-cap), trimming the boundary chunk; evicted output cannot anchor prompts in the retained tail. */
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
