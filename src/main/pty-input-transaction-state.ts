import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START
} from '../shared/agent-prompt-injection'
import { extractOnlyTerminalQueryReplies } from '../shared/terminal-query-reply'
export const MAX_PENDING_QUERY_REPLIES = 64
export const MAX_PENDING_QUERY_REPLY_CODE_UNITS = 4096
export function isPtyInputTransactionQueryReply(data: string): boolean {
  return (
    data.length <= MAX_PENDING_QUERY_REPLY_CODE_UNITS &&
    extractOnlyTerminalQueryReplies(data) !== null
  )
}
export type PendingQueryReplyState = {
  pendingQueryReplies: string[]
  pendingQueryReplyCodeUnits: number
}
export function canQueueQueryReply(state: PendingQueryReplyState, reply: string): boolean {
  return (
    state.pendingQueryReplies.length < MAX_PENDING_QUERY_REPLIES &&
    state.pendingQueryReplyCodeUnits + reply.length <= MAX_PENDING_QUERY_REPLY_CODE_UNITS
  )
}
export function enqueueQueryReply(state: PendingQueryReplyState, reply: string): void {
  state.pendingQueryReplies.push(reply)
  state.pendingQueryReplyCodeUnits += reply.length
}
export function flushQueryReplies(
  state: PendingQueryReplyState,
  write: (data: string) => boolean
): boolean {
  while (state.pendingQueryReplies.length > 0) {
    const reply = state.pendingQueryReplies[0]
    if (!write(reply)) {
      return false
    }
    state.pendingQueryReplies.shift()
    state.pendingQueryReplyCodeUnits -= reply.length
  }
  state.pendingQueryReplyCodeUnits = 0
  return true
}
export function writeQueuedQueryReply(
  state: PendingQueryReplyState,
  data: string,
  write: (data: string) => boolean
): boolean {
  if (state.pendingQueryReplies.length > 0 && !flushQueryReplies(state, write)) {
    if (canQueueQueryReply(state, data)) {
      enqueueQueryReply(state, data)
      return true
    }
    return false
  }
  const wrote = write(data)
  if (!wrote && canQueueQueryReply(state, data)) {
    enqueueQueryReply(state, data)
    return true
  }
  return wrote
}
export function nextPasteState(initial: boolean, data: string): boolean {
  let open = initial
  let cursor = 0
  while (cursor < data.length) {
    const start = data.indexOf(AGENT_PROMPT_BRACKETED_PASTE_START, cursor)
    const end = data.indexOf(AGENT_PROMPT_BRACKETED_PASTE_END, cursor)
    if (start === -1 && end === -1) {
      break
    }
    if (start !== -1 && (end === -1 || start < end)) {
      open = true
      cursor = start + AGENT_PROMPT_BRACKETED_PASTE_START.length
    } else {
      open = false
      cursor = end + AGENT_PROMPT_BRACKETED_PASTE_END.length
    }
  }
  return open
}
