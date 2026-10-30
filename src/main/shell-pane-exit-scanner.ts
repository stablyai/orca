/**
 * Chunk-boundary-safe OSC 777 orca-pane-exit scanner.
 *
 * Why: macOS login(1) always exits 0, so the TCC trampoline reports the inner
 * pane process status through this marker for `terminal wait --for exit`.
 */

export const PANE_EXIT_MARKER_PREFIX = '\x1b]777;orca-pane-exit:'

export type PaneExitScanState = {
  carry: string
}

export type PaneExitScanResult = {
  output: string
  exitCode: number | null
}

const MAX_PANE_EXIT_CARRY_LENGTH = PANE_EXIT_MARKER_PREFIX.length + 20

export function createPaneExitScanState(): PaneExitScanState {
  return { carry: '' }
}

export function resolvePaneProcessExitCode(
  processExitCode: number,
  reportedPaneExitCode: number | null
): number {
  // Why: login(1) exits 0 after a successful session even when the inner
  // exec'd command exited non-zero. Prefer the trampoline-reported code.
  if (processExitCode === 0 && reportedPaneExitCode !== null) {
    return reportedPaneExitCode
  }
  return processExitCode
}

export function scanPaneExitMarker(state: PaneExitScanState, data: string): PaneExitScanResult {
  let combined = state.carry + data
  state.carry = ''
  let output = ''
  let exitCode: number | null = null

  while (combined.length > 0) {
    const start = combined.indexOf(PANE_EXIT_MARKER_PREFIX[0] as string)
    if (start === -1) {
      output += combined
      break
    }
    output += combined.slice(0, start)
    const candidate = combined.slice(start)
    if (candidate.length < PANE_EXIT_MARKER_PREFIX.length) {
      if (PANE_EXIT_MARKER_PREFIX.startsWith(candidate)) {
        state.carry = candidate
        break
      }
      output += candidate[0]
      combined = candidate.slice(1)
      continue
    }
    if (!candidate.startsWith(PANE_EXIT_MARKER_PREFIX)) {
      output += candidate[0]
      combined = candidate.slice(1)
      continue
    }
    const suffix = candidate.slice(PANE_EXIT_MARKER_PREFIX.length)
    const terminator = suffix.indexOf('\x07')
    if (terminator === -1) {
      state.carry =
        candidate.length > MAX_PANE_EXIT_CARRY_LENGTH
          ? candidate.slice(candidate.length - MAX_PANE_EXIT_CARRY_LENGTH)
          : candidate
      break
    }
    const payload = suffix.slice(0, terminator)
    // Why: parseInt("42junk") is 42; only a complete integer is a pane status.
    if (/^-?\d+$/.test(payload)) {
      const parsed = Number.parseInt(payload, 10)
      if (Number.isSafeInteger(parsed)) {
        exitCode = parsed
      }
    }
    combined = suffix.slice(terminator + 1)
  }

  return { output, exitCode }
}
