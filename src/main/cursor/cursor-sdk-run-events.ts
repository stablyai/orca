import type { CursorSidecarEvent } from './cursor-sdk-protocol'

export type CursorRunForwardState = {
  pendingText: string
  pendingThinking: string
  lastTask: string
}

export const INITIAL_CURSOR_RUN_FORWARD_STATE: CursorRunForwardState = {
  pendingText: '',
  pendingThinking: '',
  lastTask: ''
}

type SdkContentBlock = { type?: string; text?: string }

export type CursorSdkRunMessage = {
  type: string
  text?: string
  call_id?: string
  name?: unknown
  status?: string
  args?: unknown
  result?: unknown
  message?: string | { content?: SdkContentBlock[] }
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    totalTokens?: number
  }
}

export type CursorSdkDelta = {
  type: string
  text?: string
}

type Forward = { state: CursorRunForwardState; events: CursorSidecarEvent[] }

function same(state: CursorRunForwardState): Forward {
  return { state, events: [] }
}

function absorb(pending: string, snapshot: string): { pending: string; extra: string } {
  if (!snapshot || snapshot === pending) {
    return { pending: snapshot ? '' : pending, extra: '' }
  }
  if (pending.startsWith(snapshot)) {
    return { pending, extra: '' }
  }
  if (snapshot.startsWith(pending)) {
    return { pending: '', extra: snapshot.slice(pending.length) }
  }
  return { pending, extra: '' }
}

function textOf(message: CursorSdkRunMessage): string {
  const body = message.message
  if (!body || typeof body === 'string') {
    return ''
  }
  return (body.content ?? [])
    .flatMap((block) => (block.type === 'text' && block.text ? [block.text] : []))
    .join('')
}

function toolStatus(status: string | undefined): 'running' | 'completed' | 'error' {
  return status === 'error' ? 'error' : status === 'completed' ? 'completed' : 'running'
}

export function forwardCursorSdkDelta(
  state: CursorRunForwardState,
  update: CursorSdkDelta
): Forward {
  if (update.type === 'text-delta' && update.text) {
    return {
      state: { ...state, pendingText: state.pendingText + update.text },
      events: [{ type: 'text', text: update.text }]
    }
  }
  if (update.type === 'thinking-delta' && update.text) {
    return {
      state: { ...state, pendingThinking: state.pendingThinking + update.text },
      events: [{ type: 'thinking', text: update.text }]
    }
  }
  return same(state)
}

export function forwardCursorSdkMessage(
  state: CursorRunForwardState,
  message: CursorSdkRunMessage
): Forward {
  if (message.type === 'assistant') {
    const absorbed = absorb(state.pendingText, textOf(message))
    return {
      state: { ...state, pendingText: absorbed.pending },
      events: absorbed.extra ? [{ type: 'text', text: absorbed.extra }] : []
    }
  }
  if (message.type === 'thinking' && message.text) {
    const absorbed = absorb(state.pendingThinking, message.text)
    return {
      state: { ...state, pendingThinking: absorbed.pending },
      events: absorbed.extra ? [{ type: 'thinking', text: absorbed.extra }] : []
    }
  }
  if (message.type === 'tool_call' && message.call_id) {
    const name = typeof message.name === 'string' && message.name ? message.name : 'tool'
    return {
      state,
      events: [
        {
          type: 'tool',
          callId: message.call_id,
          name,
          status: toolStatus(message.status),
          ...(message.args !== undefined ? { args: message.args } : {}),
          ...(message.result !== undefined ? { result: message.result } : {})
        }
      ]
    }
  }
  if (message.type === 'task' && message.text && message.text !== state.lastTask) {
    return {
      state: { ...state, lastTask: message.text },
      events: [{ type: 'task', text: message.text }]
    }
  }
  const usage = message.usage
  if (
    message.type === 'usage' &&
    usage &&
    typeof usage.inputTokens === 'number' &&
    typeof usage.outputTokens === 'number' &&
    typeof usage.cacheReadTokens === 'number' &&
    typeof usage.cacheWriteTokens === 'number' &&
    typeof usage.totalTokens === 'number'
  ) {
    return {
      state,
      events: [
        {
          type: 'usage',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          totalTokens: usage.totalTokens
        }
      ]
    }
  }
  return same(state)
}
