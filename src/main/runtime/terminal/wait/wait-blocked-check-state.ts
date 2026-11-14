import {
  sliceTerminalOrigins,
  type TerminalOriginRuns
} from '../../../../shared/terminal/output/terminal-content-origin'
import { MAX_TAIL_CHARS } from '../output/tail/terminal-tail-limits'
import type { TerminalTailWaitState } from './terminal-wait-tail-state'

/** Retain chunks and join once per throttled scan; per-frame concatenation/slicing flattened the full 256KiB window after saturation. */
export type WaitBlockedAppendedCarry = {
  chunks: string[]
  origins: TerminalOriginRuns[]
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
  return { chunks: [], origins: [], chars: 0 }
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
export function appendWaitBlockedCarry(
  carry: WaitBlockedAppendedCarry,
  chunk: string,
  origins: TerminalOriginRuns = []
): void {
  if (chunk.length === 0) {
    return
  }
  carry.chunks.push(chunk)
  carry.origins.push(origins)
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
    carry.origins[dropCount] = sliceTerminalOrigins(carry.origins[dropCount], excess)
    excess = 0
  }
  if (dropCount > 0) {
    carry.chunks.splice(0, dropCount)
    carry.origins.splice(0, dropCount)
  }
  carry.chars = MAX_TAIL_CHARS
}

export function readWaitBlockedCarry(carry: WaitBlockedAppendedCarry): {
  text: string
  origins: TerminalOriginRuns
} {
  let offset = 0
  const origins = carry.origins.flatMap((runs, index) => {
    const shifted = runs.map((run) => ({
      ...run,
      start: offset + run.start,
      end: offset + run.end
    }))
    offset += carry.chunks[index]!.length
    return shifted
  })
  return { text: carry.chunks.length === 1 ? carry.chunks[0]! : carry.chunks.join(''), origins }
}

export function resetWaitBlockedCarry(carry: WaitBlockedAppendedCarry): void {
  carry.chunks.length = 0
  carry.origins.length = 0
  carry.chars = 0
}
