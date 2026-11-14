import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

type QueuedMessage = {
  message: SDKUserMessage
  beforeDispatch?: () => Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

type ClaudeUserMessageFailureDisposition = 'unwritten' | 'write-outcome-unknown'

class ClaudeUserMessageFailure extends Error {
  readonly disposition: ClaudeUserMessageFailureDisposition

  constructor(disposition: ClaudeUserMessageFailureDisposition, cause: Error) {
    super(cause.message, { cause })
    this.name = 'ClaudeUserMessageFailure'
    this.disposition = disposition
  }
}

export function claudeUnwrittenUserMessageError(cause: Error): Error {
  return new ClaudeUserMessageFailure('unwritten', cause)
}

export function claudeUserMessageWasProvablyUnwritten(error: unknown): boolean {
  return error instanceof ClaudeUserMessageFailure && error.disposition === 'unwritten'
}

function claudeAmbiguousUserMessageError(cause: Error): Error {
  return new ClaudeUserMessageFailure('write-outcome-unknown', cause)
}

export type ClaudeUserMessageQueue = {
  /** The SDK's streaming-input prompt; it stays open until `end`. */
  messages: AsyncIterable<SDKUserMessage>
  /** Resolves once the SDK has finished writing the frame to the child. */
  push: (message: SDKUserMessage, beforeDispatch?: () => Promise<void>) => Promise<void>
  /** Reject every unsettled frame; an in-flight frame carries an ambiguous write outcome. */
  fail: (error: Error) => void
  end: () => void
}

const UNCONFIRMED_FRAME_MESSAGE = 'claude stream-json input ended before confirming the frame write'

export function createClaudeUserMessageQueue(): ClaudeUserMessageQueue {
  const queued: QueuedMessage[] = []
  // Retain the frame removed from queued so failures can settle it.
  let inFlight: QueuedMessage | null = null
  let handedOff = false
  let wake: (() => void) | null = null
  let ended = false
  let failure: Error | null = null
  const notify = (): void => {
    wake?.()
    wake = null
  }
  const rejectInFlight = (error: Error): void => {
    const abandoned = inFlight
    inFlight = null
    abandoned?.reject(error)
  }

  async function* drain(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = queued.shift()
      if (next) {
        inFlight = next
        handedOff = false
        if (next.beforeDispatch) {
          try {
            await next.beforeDispatch()
          } catch (error) {
            inFlight = null
            next.reject(error instanceof Error ? error : new Error('claude dispatch refused'))
            continue
          }
          if (failure) {
            inFlight = null
            next.reject(claudeUnwrittenUserMessageError(failure))
            continue
          }
        }
        let written = false
        try {
          handedOff = true
          yield next.message
          written = true
        } finally {
          // The SDK may abandon the iterator on write failure; finally must settle the yielded frame.
          if (written) {
            inFlight = null
            // The SDK resumes only after transport.write completes.
            next.resolve()
          } else {
            rejectInFlight(
              claudeAmbiguousUserMessageError(failure ?? new Error(UNCONFIRMED_FRAME_MESSAGE))
            )
          }
        }
        continue
      }
      if (ended || failure) {
        return
      }
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  }

  return {
    messages: drain(),
    push: (message, beforeDispatch) =>
      new Promise<void>((resolve, reject) => {
        if (failure) {
          reject(claudeUnwrittenUserMessageError(failure))
          return
        }
        queued.push({ message, beforeDispatch, resolve, reject })
        notify()
      }),
    fail: (error) => {
      failure ??= error
      for (const entry of queued.splice(0)) {
        entry.reject(claudeUnwrittenUserMessageError(error))
      }
      // Reject handed-off frames even if the pump stalls; pending authorization must unwind first.
      if (handedOff) {
        rejectInFlight(claudeAmbiguousUserMessageError(error))
      }
      notify()
    },
    end: () => {
      ended = true
      notify()
    }
  }
}
