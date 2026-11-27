const AGENT_MESSAGE_DELTA_METHOD = 'item/agentMessage/delta'

type DeltaParams = { threadId: string; turnId: string; itemId: string; delta: string }
type HeldDelta = { message: Record<string, unknown>; params: DeltaParams; parts: string[] }

export type CodexAgentMessageDeltaBatch = {
  dispatch: (message: Record<string, unknown>) => void
  /** Hands on a held delta; call before anything else reaches the connection's handlers. */
  flush: () => void
}

function deltaParams(message: Record<string, unknown>): DeltaParams | null {
  if (message.method !== AGENT_MESSAGE_DELTA_METHOD || 'id' in message) {
    return null
  }
  const params = message.params
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return null
  }
  const { threadId, turnId, itemId, delta, ...rest } = params as Record<string, unknown>
  // Unknown fields can't be merged safely, so such a delta passes through alone.
  return typeof threadId === 'string' &&
    typeof turnId === 'string' &&
    typeof itemId === 'string' &&
    typeof delta === 'string' &&
    Object.keys(rest).length === 0
    ? { threadId, turnId, itemId, delta }
    : null
}

/**
 * Same-tick batching: Codex writes most message deltas in bursts that arrive in one read, so
 * consecutive deltas for one item read in the same task reach the handlers as one, in order.
 * Adds no delay: what is held is handed on at the end of the current task, before any timer.
 */
export function createCodexAgentMessageDeltaBatch(
  dispatch: (message: Record<string, unknown>) => void,
  /** A handler that throws while handing on a held delta, as the reader's own failure. */
  onError: (error: Error) => void
): CodexAgentMessageDeltaBatch {
  let held: HeldDelta | null = null
  let scheduled = false

  const flush = (): void => {
    if (!held) {
      return
    }
    const { message, params, parts } = held
    held = null
    dispatch(parts.length === 1 ? message : { ...message, params: { ...params, delta: parts.join('') } })
  }

  return {
    dispatch: (message) => {
      const params = deltaParams(message)
      if (
        params &&
        held &&
        held.params.itemId === params.itemId &&
        held.params.turnId === params.turnId &&
        held.params.threadId === params.threadId
      ) {
        held.parts.push(params.delta)
        held.message = message
        return
      }
      flush()
      if (!params) {
        dispatch(message)
        return
      }
      held = { message, params, parts: [params.delta] }
      if (!scheduled) {
        scheduled = true
        queueMicrotask(() => {
          scheduled = false
          try {
            flush()
          } catch (error) {
            onError(error instanceof Error ? error : new Error(String(error)))
          }
        })
      }
    },
    flush
  }
}
