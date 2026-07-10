import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'

const TERMINAL_WAIT_SCAN_TAIL_LIMIT = 1024
const BLOCKED_PROMPT_ANCHOR_PATTERN =
  /update available|choose working directory to|codex just got an upgrade|hooks need review|do you trust|trust this|trusted workspace|press enter to confirm|press enter to continue|press enter to view|press enter to insert|press t to trust/i

export type TerminalTailWaitState = {
  waitText: string
  signal: { reason: RuntimeTerminalWaitBlockedReason; index: number } | null
  /** Why: preview fallback changes after append, so only tail-derived state is reusable. */
  fromTail: boolean
  /** Why: a bounded suffix recognizes split anchors without rebuilding an anchor-free tail. */
  anchorFreeScanTail?: string
}

export function createAnchorFreeTerminalTailWaitState(
  lines: readonly string[],
  partialLine: string,
  preview: string
): TerminalTailWaitState | null {
  let fromTail = partialLine.trim().length > 0
  if (BLOCKED_PROMPT_ANCHOR_PATTERN.test(partialLine)) {
    return null
  }
  for (const line of lines) {
    fromTail ||= line.trim().length > 0
    if (BLOCKED_PROMPT_ANCHOR_PATTERN.test(line)) {
      return null
    }
  }
  if (!fromTail && BLOCKED_PROMPT_ANCHOR_PATTERN.test(preview)) {
    return null
  }
  return {
    // Why: tailGainedNewerBlockedReason only reads prior waitText when prior
    // signal is non-null. Anchor-free states cannot have a signal, so retain
    // only the small raw suffix needed to recognize a split future anchor.
    waitText: fromTail ? '' : preview,
    signal: null,
    fromTail,
    anchorFreeScanTail: buildTerminalWaitScanTail(lines, partialLine)
  }
}

export function advanceAnchorFreeTerminalTailWaitState(
  previous: TerminalTailWaitState,
  appendedText: string
): TerminalTailWaitState | null {
  if (
    previous.signal !== null ||
    previous.anchorFreeScanTail === undefined ||
    !isPlainMeaningfulTerminalAppend(appendedText)
  ) {
    return null
  }
  const scanText = `${previous.anchorFreeScanTail}${appendedText}`
  if (BLOCKED_PROMPT_ANCHOR_PATTERN.test(scanText)) {
    return null
  }
  return {
    waitText: '',
    signal: null,
    fromTail: true,
    anchorFreeScanTail: scanText.slice(-TERMINAL_WAIT_SCAN_TAIL_LIMIT)
  }
}

function isPlainMeaningfulTerminalAppend(value: string): boolean {
  if (value.length === 0 || value.trim().length === 0) {
    return false
  }
  // CR, backspace, and retained ANSI cursor controls can rewrite prior text
  // and therefore must rebuild state from the authoritative terminal tail.
  return !value.includes('\r') && !value.includes('\b') && !value.includes('\x1b')
}

function buildTerminalWaitScanTail(lines: readonly string[], partialLine: string): string {
  let tail = partialLine.slice(-TERMINAL_WAIT_SCAN_TAIL_LIMIT)
  for (
    let index = lines.length - 1;
    index >= 0 && tail.length < TERMINAL_WAIT_SCAN_TAIL_LIMIT;
    index--
  ) {
    const separator = tail.length > 0 ? '\n' : ''
    const remaining = TERMINAL_WAIT_SCAN_TAIL_LIMIT - tail.length - separator.length
    if (remaining <= 0) {
      break
    }
    tail = `${lines[index]!.slice(-remaining)}${separator}${tail}`
  }
  return tail
}
