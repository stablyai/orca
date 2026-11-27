import type { NdjsonRejectedRecord } from '../../../shared/json-stream/main-process-ndjson-framer'
import { isProviderRecord } from '../../provider-process/provider-json-record'

const AGENT_MESSAGE_DELTA_METHOD = 'item/agentMessage/delta'

type DeltaParams = { threadId: string; turnId: string; itemId: string; delta: string }
type HeldDelta = { message: Record<string, unknown>; params: DeltaParams; parts: string[] }

export type CodexAgentMessageDeltaBatch = {
  dispatch: (message: Record<string, unknown>) => void
  /** Anything else for the handlers: after a held delta, and after records waiting on a resume. */
  handOn: (run: () => void) => void
  /** Hands on a held delta now. */
  flush: () => void
  /** Hands on records that arrived while reading was paused, until it pauses again. */
  resume: () => void
}

function deltaParams(message: Record<string, unknown>): DeltaParams | null {
  if (message.method !== AGENT_MESSAGE_DELTA_METHOD || 'id' in message) {
    return null
  }
  const params = message.params
  if (!isProviderRecord(params)) {
    return null
  }
  const { threadId, turnId, itemId, delta, ...rest } = params
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
 * A held delta's handler may pause reading; the record read after it then waits for the resume,
 * as it would have waited in the reader.
 */
export function createCodexAgentMessageDeltaBatch(input: {
  dispatch: (message: Record<string, unknown>) => void
  /** A handler that throws while handing on a held delta, as the reader's own failure. */
  onError: (error: Error) => void
  isPaused: () => boolean
}): CodexAgentMessageDeltaBatch {
  let held: HeldDelta | null = null
  let scheduled = false
  const waiting: (() => void)[] = []

  const flush = (): void => {
    if (!held) {
      return
    }
    const { message, params, parts } = held
    held = null
    input.dispatch(
      parts.length === 1 ? message : { ...message, params: { ...params, delta: parts.join('') } }
    )
  }
  const handOn = (run: () => void): void => {
    flush()
    if (waiting.length > 0 || input.isPaused()) {
      waiting.push(run)
    } else {
      run()
    }
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
      if (!params || waiting.length > 0 || input.isPaused()) {
        handOn(() => input.dispatch(message))
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
            input.onError(error instanceof Error ? error : new Error(String(error)))
          }
        })
      }
    },
    handOn,
    flush,
    resume: () => {
      while (waiting.length > 0 && !input.isPaused()) {
        waiting.shift()!()
      }
    }
  }
}

/** The connection's record-reader callbacks: every record and rejection follows a held delta and
 *  any record waiting on a resume, so nothing overtakes them. */
export function batchedCodexRecordCallbacks(input: {
  dispatch: (message: Record<string, unknown>) => void
  rejectOversized: (rejected: NdjsonRejectedRecord & { kind: 'line-too-long' }) => void
  onUnhandledFrame: (kind: 'frame:invalid-json', line: string) => void
  onFatal: (error: Error) => void
  isPaused: () => boolean
}): {
  onRecord: (record: unknown, line: string) => void
  onRejected: (rejected: NdjsonRejectedRecord) => void
  onFatal: (error: Error) => void
  resume: () => void
} {
  const deltas = createCodexAgentMessageDeltaBatch({
    dispatch: input.dispatch,
    onError: input.onFatal,
    isPaused: input.isPaused
  })
  return {
    onRecord: (record, line) => {
      if (isProviderRecord(record)) {
        deltas.dispatch(record)
      } else {
        deltas.handOn(() => input.onUnhandledFrame('frame:invalid-json', line))
      }
    },
    onRejected: (rejected) =>
      deltas.handOn(() => {
        if (rejected.kind === 'invalid-json') {
          input.onUnhandledFrame('frame:invalid-json', rejected.line)
        } else {
          input.rejectOversized(rejected)
        }
      }),
    // A failing reader is reported at once; the connection is closing.
    onFatal: (error) => {
      try {
        deltas.flush()
      } catch {
        // The reader's own error is the one reported.
      }
      input.onFatal(error)
    },
    resume: deltas.resume
  }
}
