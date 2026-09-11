import type { RpcResponse } from '../transport/types'
import {
  isMethodNotFoundRefusal,
  rpcObjectResultOrNull
} from '../transport/rpc-acceptance-policies'

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

export function isTerminalUpdateViewportUpdated(response: RpcResponse): boolean {
  return rpcObjectResultOrNull(response)?.updated === true
}

export function isTerminalUpdateViewportApplied(response: RpcResponse): boolean {
  return rpcObjectResultOrNull(response)?.applied === true
}

export function resolveTerminalUpdateViewportCapability(
  response: RpcResponse
): TerminalUpdateViewportCapability {
  if (response.ok) {
    return 'supported'
  }
  return isMethodNotFoundRefusal(response) ? 'unsupported' : 'unknown'
}

// Why: defer height refits while typing, then coalesce every skipped layout
// change into one correction after the keyboard closes.
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
    // Why: the debounced height refit is firing. The keyboard can reopen during
    // the debounce window, so re-check here and re-defer rather than reflow the
    // PTY mid-keystroke; it runs on the next keyboard close.
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
