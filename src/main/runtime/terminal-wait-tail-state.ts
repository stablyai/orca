import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'
import { buildTailLines } from './terminal-tail-state'
import { tailMayContainBlockedSignal } from './terminal-tail-sentinel-index'
import { findActionableTerminalWaitBlockedSignal } from './terminal-wait-detection'
import { terminalWaitBlockedSentinelRe } from './agent-state-rules/blocked-text-layer'

export function buildTerminalWaitText(
  lines: string[],
  partialLine: string,
  preview: string
): string {
  const waitText = buildTailLines(lines, partialLine)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
  // Readiness headers can fall outside the short preview.
  return waitText.length > 0 ? waitText : preview
}

export type TerminalTailWaitState = {
  waitText: string
  signal: { reason: RuntimeTerminalWaitBlockedReason; index: number } | null
  // Preview fallback changes every append and cannot seed the next cached tail state.
  fromTail: boolean
}

// Per-chunk caching avoids reparsing 256KiB tails; parse only candidate-bearing tails.
export function computeTerminalTailWaitState(
  lines: string[],
  partialLine: string,
  preview: string
): TerminalTailWaitState {
  const tailInspection = inspectTerminalWaitTail(lines, partialLine)
  if (!tailInspection.fromTail) {
    return {
      waitText: preview,
      signal: findActionableTerminalWaitBlockedSignal(preview.toLowerCase()),
      fromTail: false
    }
  }
  if (!tailInspection.mayContainBlockedSignal) {
    // Signal-free chunks need no retained 256KiB waitText rebuild.
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
    // Absence requires a full scan; the index instead checks only newly produced lines.
    mayContainBlockedSignal:
      tailMayContainBlockedSignal(lines) || terminalWaitBlockedSentinelRe().test(partialLine)
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

// Reuse precomputed states to avoid another full-tail scan per chunk.
export function tailGainedNewerBlockedReason(
  previous: TerminalTailWaitState,
  next: TerminalTailWaitState,
  appendedText: string
): boolean {
  if (next.signal === null) {
    return false
  }
  // Permission prompts span chunks; stamp first blocking or a newer prompt after stale blocked text.
  if (previous.signal === null) {
    return true
  }
  const appendCandidateSignal = findActionableTerminalWaitBlockedSignal(
    `${previous.waitText}${appendedText}`.toLowerCase()
  )
  return appendCandidateSignal !== null && appendCandidateSignal.index > previous.signal.index
}
