import type { SetStateAction } from 'react'
import type { MobileNativeChatSendOrigin } from './mobile-native-chat-pending-echo'

export type MobileNativeChatDraftOwnership = {
  drafts: Record<string, string>
  origins: ReadonlySet<MobileNativeChatSendOrigin>
}

export type MobileNativeChatDraftAction =
  | { type: 'seed'; value: SetStateAction<Record<string, string>> }
  | { type: 'edit'; draftKey: string; value: SetStateAction<string> }
  | { type: 'capture'; origin: MobileNativeChatSendOrigin }
  | { type: 'release'; origin: MobileNativeChatSendOrigin }
  | { type: 'clear' | 'restore'; origin: MobileNativeChatSendOrigin; text: string }

export function createMobileNativeChatDraftOwnership(): MobileNativeChatDraftOwnership {
  return { drafts: {}, origins: new Set() }
}

export function reduceMobileNativeChatDraftOwnership(
  state: MobileNativeChatDraftOwnership,
  action: MobileNativeChatDraftAction
): MobileNativeChatDraftOwnership {
  if (action.type === 'seed') {
    const drafts = typeof action.value === 'function' ? action.value(state.drafts) : action.value
    return drafts === state.drafts ? state : { ...state, drafts }
  }
  if (action.type === 'edit') {
    const current = state.drafts[action.draftKey] ?? ''
    const next = typeof action.value === 'function' ? action.value(current) : action.value
    const origins = new Set(state.origins)
    for (const origin of origins) {
      if (origin.draftKey === action.draftKey) {
        origins.delete(origin)
      }
    }
    return { drafts: { ...state.drafts, [action.draftKey]: next }, origins }
  }
  if (action.type === 'capture') {
    return { ...state, origins: new Set([...state.origins, action.origin]) }
  }
  if (!state.origins.has(action.origin)) {
    return state
  }
  if (action.type === 'release') {
    const origins = new Set(state.origins)
    origins.delete(action.origin)
    return { ...state, origins }
  }
  const { draftKey } = action.origin
  const current = state.drafts[draftKey] ?? ''
  const expected = action.type === 'clear' ? action.text : ''
  if (current !== expected) {
    return state
  }
  return {
    ...state,
    drafts: { ...state.drafts, [draftKey]: action.type === 'clear' ? '' : action.text }
  }
}
