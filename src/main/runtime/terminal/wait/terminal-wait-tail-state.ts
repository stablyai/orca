import {
  terminalSupportQuery,
  lowercaseTerminalSupport,
  type TerminalContentOrigin,
  type TerminalOriginRuns
} from '../../../../shared/terminal/output/terminal-content-origin'
import { readTerminalActionText, type ActionTextRecord } from '../output/terminal-action-text'
import type { RuntimeTerminalWaitBlockedReason } from '../../../../shared/runtime-terminal-contracts'
import { buildTailLines } from '../output/tail/terminal-tail-state'
import { tailMayContainBlockedSignal } from '../output/tail/terminal-tail-sentinel-index'
import {
  detectTerminalWaitBlockedReason,
  findActionableTerminalWaitBlockedSignal
} from './terminal-wait-detection'
import { terminalWaitBlockedSentinelRe } from '../../agent-state-rules/blocked-text-layer'

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

/** Re-rank live state after awaits without rebuilding an unchanged tail within that tick. */
export function createTerminalWaitTailReader(record: ActionTextRecord) {
  let previous: ReturnType<typeof readTerminalActionText> | undefined
  let blocked: RuntimeTerminalWaitBlockedReason | null = null
  return {
    readText: () => readTerminalActionText(record).text,
    readBlockedReason: () => {
      const current = readTerminalActionText(record)
      if (current !== previous) {
        previous = current
        blocked = detectTerminalWaitBlockedReason(current.text, current.query)
      }
      return blocked
    }
  }
}

export type TerminalTailWaitState = {
  waitText: string
  origins?: TerminalOriginRuns
  signal: { reason: RuntimeTerminalWaitBlockedReason; index: number } | null
  // Preview fallback changes every append and cannot seed the next cached tail state.
  fromTail: boolean
}

// Per-chunk caching avoids reparsing 256KiB tails; parse only candidate-bearing tails.
export function computeTerminalTailWaitState(
  lines: string[],
  partialLine: string,
  preview: string,
  action?: ActionTextRecord
): TerminalTailWaitState {
  const tailInspection = inspectTerminalWaitTail(lines, partialLine)
  if (!tailInspection.fromTail) {
    const view = action ? readTerminalActionText(action) : undefined
    return {
      waitText: view?.text ?? preview,
      origins: view?.origins,
      signal: findActionableTerminalWaitBlockedSignal(
        view?.lower ?? preview.toLowerCase(),
        view?.lowerQuery
      ),
      fromTail: false
    }
  }
  if (!tailInspection.mayContainBlockedSignal) {
    // Signal-free chunks need no retained 256KiB waitText rebuild.
    return { waitText: '', signal: null, fromTail: true }
  }
  const actionText = action ? readTerminalActionText(action) : undefined
  const tailText =
    actionText?.text ??
    buildTailLines(lines, partialLine)
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n')
  const fromTail = tailText.length > 0
  const waitText = actionText ? actionText.text : fromTail ? tailText : preview
  return {
    waitText,
    origins: actionText?.origins,
    signal: findActionableTerminalWaitBlockedSignal(
      actionText?.lower ?? waitText.toLowerCase(),
      actionText?.lowerQuery
    ),
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
  appendedText: string,
  appendedOrigins: TerminalOriginRuns = [],
  scope?: TerminalContentOrigin
): boolean {
  if (next.signal === null) {
    return false
  }
  // Permission prompts span chunks; stamp first blocking or a newer prompt after stale blocked text.
  const prior = lowercaseTerminalSupport(
    previous.waitText,
    terminalSupportQuery(previous.origins ?? [], scope)
  )
  const previousSignal = findActionableTerminalWaitBlockedSignal(prior.text, prior.query)
  if (previousSignal === null) {
    return true
  }
  const combined = previous.waitText + appendedText
  const origins = [
    ...(previous.origins ?? []),
    ...appendedOrigins.map((run) => ({
      ...run,
      start: run.start + previous.waitText.length,
      end: run.end + previous.waitText.length
    }))
  ]
  const normalized = lowercaseTerminalSupport(combined, terminalSupportQuery(origins, scope))
  const appended = findActionableTerminalWaitBlockedSignal(normalized.text, normalized.query)
  return appended !== null && appended.index > previousSignal.index
}
