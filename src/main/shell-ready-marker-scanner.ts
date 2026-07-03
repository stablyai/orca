export const SHELL_READY_MARKER_PREFIX = '\x1b]777;orca-shell-ready'
export const SHELL_READY_MARKER = `${SHELL_READY_MARKER_PREFIX}\x07`

export type ShellReadyScanState = {
  matchPos: number
  heldBytes: string
}

export type ShellReadyScanResult = {
  output: string
  matched: boolean
  postMarkerBytesObserved: boolean
}

export function createShellReadyScanState(): ShellReadyScanState {
  return { matchPos: 0, heldBytes: '' }
}

export function drainShellReadyHeldBytes(state: ShellReadyScanState): string {
  const heldBytes = state.heldBytes
  state.heldBytes = ''
  state.matchPos = 0
  return heldBytes
}

export function scanForShellReady(state: ShellReadyScanState, data: string): ShellReadyScanResult {
  let output = ''

  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i] as string
    if (state.matchPos < SHELL_READY_MARKER_PREFIX.length) {
      if (ch === SHELL_READY_MARKER_PREFIX[state.matchPos]) {
        state.heldBytes += ch
        state.matchPos += 1
      } else {
        output += state.heldBytes
        state.heldBytes = ''
        state.matchPos = 0
        if (ch === SHELL_READY_MARKER_PREFIX[0]) {
          state.heldBytes = ch
          state.matchPos = 1
        } else {
          output += ch
        }
      }
    } else if (ch === '\x07') {
      const remaining = data.slice(i + 1)
      state.heldBytes = ''
      state.matchPos = 0
      return {
        output: output + remaining,
        matched: true,
        postMarkerBytesObserved: remaining.length > 0
      }
    } else {
      output += state.heldBytes
      state.heldBytes = ''
      state.matchPos = 0
      if (ch === SHELL_READY_MARKER_PREFIX[0]) {
        state.heldBytes = ch
        state.matchPos = 1
      } else {
        output += ch
      }
    }
  }

  return { output, matched: false, postMarkerBytesObserved: false }
}
