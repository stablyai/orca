export const SHELL_READY_MARKER_PREFIX = '\x1b]777;orca-shell-ready'

export type ShellReadyScanState = {
  matchPos: number
  heldBytes: string
}

export type ShellReadyScanResult = {
  output: string
  matched: boolean
  postMarkerBytesObserved: boolean
  nativeSetupShell?: 'posix' | 'fish'
}

type ShellReadyBoundaryScanResult = ShellReadyScanResult & {
  postMarkerOutputIndex: number | null
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

export function scanForShellReadyBoundary(
  state: ShellReadyScanState,
  data: string,
  emit?: (data: string, removed?: boolean) => void
): ShellReadyBoundaryScanResult {
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
      const marker = state.heldBytes
      state.heldBytes = ''
      state.matchPos = 0
      emit?.(output)
      emit?.('', true)
      emit?.(remaining)
      return {
        output: output + remaining,
        matched: true,
        postMarkerBytesObserved: remaining.length > 0,
        postMarkerOutputIndex: output.length,
        ...(marker.endsWith(':fish') ? { nativeSetupShell: 'fish' as const } : {}),
        ...(marker.endsWith(':posix') ? { nativeSetupShell: 'posix' as const } : {})
      }
    } else if (
      [':posix', ':fish'].some((suffix) =>
        `${SHELL_READY_MARKER_PREFIX}${suffix}`.startsWith(state.heldBytes + ch)
      )
    ) {
      state.heldBytes += ch
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

  emit?.(output)
  return {
    output,
    matched: false,
    postMarkerBytesObserved: false,
    postMarkerOutputIndex: null
  }
}

export function scanForShellReady(state: ShellReadyScanState, data: string): ShellReadyScanResult {
  const { postMarkerOutputIndex: _, ...result } = scanForShellReadyBoundary(state, data)
  return result
}
