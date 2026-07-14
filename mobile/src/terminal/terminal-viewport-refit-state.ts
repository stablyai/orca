import type { RpcResponse } from '../transport/types'

export type TerminalViewportRefitTargetState = {
  activeHandle: string | null
  expectedHandle: string
  currentRef: unknown
  expectedRef: unknown
  disposed: boolean
  runSeq: number
  currentRunSeq: number
}

export function isTerminalUpdateViewportUpdated(response: RpcResponse): boolean {
  if (!response.ok || typeof response.result !== 'object' || response.result == null) {
    return false
  }
  return (response.result as { updated?: unknown }).updated === true
}

export function isTerminalUpdateViewportApplied(response: RpcResponse): boolean {
  if (!response.ok || typeof response.result !== 'object' || response.result == null) {
    return false
  }
  return (response.result as { applied?: unknown }).applied === true
}

// Why: re-fit when the flex-bounded frame height settles, but never while the
// keyboard is visible so an IME window resize (Android adjustResize) can't
// reflow the PTY per keystroke — it re-fits again once the keyboard closes.
export function shouldRefitOnFrameHeightChange(state: {
  previousHeight: number
  nextHeight: number
  keyboardVisible: boolean
}): boolean {
  if (state.keyboardVisible) {
    return false
  }
  return state.previousHeight !== state.nextHeight
}

export function isTerminalViewportRefitTargetCurrent(
  state: TerminalViewportRefitTargetState
): boolean {
  return (
    !state.disposed &&
    state.runSeq === state.currentRunSeq &&
    state.activeHandle === state.expectedHandle &&
    state.currentRef === state.expectedRef
  )
}
