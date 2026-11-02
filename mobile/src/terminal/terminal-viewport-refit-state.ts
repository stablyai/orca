import type { RpcResponse } from '../transport/types'
import { isMethodNotFoundRefusal } from '../transport/rpc-acceptance-policies'

export type TerminalUpdateViewportCapability = 'unknown' | 'supported' | 'unsupported'

export type TerminalViewportRefitTargetState = {
  activeHandle: string | null
  expectedHandle: string
  currentRef: unknown
  expectedRef: unknown
  nativeChatCovered: boolean
  disposed: boolean
  runSeq: number
  currentRunSeq: number
}

export type TerminalViewportUpdateOutcome = { updated: boolean; applied: boolean }

export function resolveTerminalUpdateViewportCapability(
  response: RpcResponse
): TerminalUpdateViewportCapability {
  if (response.ok) {
    return 'supported'
  }
  return isMethodNotFoundRefusal(response) ? 'unsupported' : 'unknown'
}

// Defer typing-time height refits and coalesce them into one correction after keyboard close.
export type TerminalFrameHeightRefitState = {
  frameHeight: number
  keyboardVisible: boolean
  pending: boolean
}

export type TerminalFrameHeightRefitEvent =
  | { type: 'frame-height'; height: number }
  | { type: 'keyboard-visibility'; visible: boolean }
  | { type: 'refit-committed' }

export function reduceTerminalFrameHeightRefit(
  state: TerminalFrameHeightRefitState,
  event: TerminalFrameHeightRefitEvent
): { state: TerminalFrameHeightRefitState; shouldRefit: boolean } {
  if (event.type === 'refit-committed') {
    // Keyboard may reopen during debounce; defer again instead of reflowing mid-keystroke.
    if (state.keyboardVisible) {
      return { state: { ...state, pending: true }, shouldRefit: false }
    }
    return { state: { ...state, pending: false }, shouldRefit: true }
  }

  if (event.type === 'keyboard-visibility') {
    if (event.visible === state.keyboardVisible) {
      return { state, shouldRefit: false }
    }
    if (event.visible) {
      return { state: { ...state, keyboardVisible: true }, shouldRefit: false }
    }
    return {
      state: { ...state, keyboardVisible: false, pending: false },
      shouldRefit: state.pending
    }
  }

  if (event.height === state.frameHeight) {
    return { state, shouldRefit: false }
  }
  if (state.keyboardVisible) {
    return {
      state: { ...state, frameHeight: event.height, pending: true },
      shouldRefit: false
    }
  }
  return {
    state: { ...state, frameHeight: event.height, pending: false },
    shouldRefit: true
  }
}

export function isTerminalViewportRefitTargetCurrent(
  state: TerminalViewportRefitTargetState
): boolean {
  return (
    !state.nativeChatCovered &&
    !state.disposed &&
    state.runSeq === state.currentRunSeq &&
    state.activeHandle === state.expectedHandle &&
    state.currentRef === state.expectedRef
  )
}
