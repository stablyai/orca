import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'
import { buildTailLines } from './terminal-tail-state'
import { tailMayContainBlockedSignal } from './terminal-tail-sentinel-index'
import {
  findActionableTerminalWaitBlockedSignal,
  TERMINAL_WAIT_BLOCKED_SENTINEL_RE
} from './terminal-wait-detection'

export function buildTerminalWaitText(
  lines: string[],
  partialLine: string,
  preview: string
): string {
  const waitText = buildTailLines(lines, partialLine)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
  // Why: the preview is intentionally short, but wait readiness needs the retained tail so ready headers aren't truncated away.
  return waitText.length > 0 ? waitText : preview
}

export type TerminalTailWaitState = {
  waitText: string
  signal: { reason: RuntimeTerminalWaitBlockedReason; index: number } | null
  // Why: preview is only an empty-tail fallback, recomputed each append, so a preview-derived state can't be reused as the next previous state (gated on fromTail).
  fromTail: boolean
}

// Why: runs per PTY chunk (hundreds/sec); only candidate-bearing tails parse the full 256 KiB, and the cached state avoids repeating that work next chunk.
export function computeTerminalTailWaitState(
  lines: string[],
  partialLine: string,
  preview: string
): TerminalTailWaitState {
  const tailShape = inspectTerminalWaitTail(lines, partialLine)
  if (!tailShape.fromTail) {
    return {
      waitText: preview,
      signal: findActionableTerminalWaitBlockedSignal(preview.toLowerCase()),
      fromTail: false
    }
  }
  if (!tailShape.mayContainBlockedSignal) {
    // Why: reads waitText only when a signal exists; avoid retaining a rebuilt 256 KiB string in the common case.
    return { waitText: '', signal: null, fromTail: true }
  }
  const tailText = buildTailLines(lines, partialLine)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
  const fromTail = tailText.length > 0
  const waitText = fromTail ? tailText : preview
  return {
    waitText,
    signal: findActionableTerminalWaitBlockedSignal(waitText.toLowerCase()),
    fromTail
  }
}

function inspectTerminalWaitTail(
  lines: string[],
  partialLine: string
): { fromTail: boolean; mayContainBlockedSignal: boolean } {
  return {
    fromTail: hasVisibleTailLine(lines) || partialLine.trim().length > 0,
    // Why the index: proving a signal is ABSENT can't early-exit, so a full re-test of the
    // 2000-line tail ran per scan; the index tests only the lines each append produced.
    mayContainBlockedSignal:
      tailMayContainBlockedSignal(lines) || TERMINAL_WAIT_BLOCKED_SENTINEL_RE.test(partialLine)
  }
}

function hasVisibleTailLine(lines: string[]): boolean {
  for (const line of lines) {
    if (line.trim().length > 0) {
      return true
    }
  }
  return false
}

// Why: consumes precomputed wait states so full-tail scans aren't repeated per chunk (replaces the former inline double full-tail scan).
export function tailGainedNewerBlockedReason(
  previous: TerminalTailWaitState,
  next: TerminalTailWaitState,
  appendedText: string
): boolean {
  if (next.signal === null) {
    return false
  }
  // Why: permission prompts can split across PTY chunks; stamp when the tail first becomes blocked, or a later prompt follows stale blocked text.
  if (previous.signal === null) {
    return true
  }
  const appendCandidateSignal = findActionableTerminalWaitBlockedSignal(
    `${previous.waitText}${appendedText}`.toLowerCase()
  )
  return appendCandidateSignal !== null && appendCandidateSignal.index > previous.signal.index
}
