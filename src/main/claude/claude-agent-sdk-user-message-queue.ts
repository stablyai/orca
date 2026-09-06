import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

type QueuedMessage = {
  message: SDKUserMessage
  resolve: () => void
  reject: (error: Error) => void
}

export type ClaudeUserMessageQueue = {
  /** The SDK's streaming-input prompt; it stays open until `end`. */
  messages: AsyncIterable<SDKUserMessage>
  /** Resolves once the SDK has finished writing the frame to the child. */
  push: (message: SDKUserMessage) => Promise<void>
  /** Reject every unwritten frame, in-flight included; a caller waiting on a send must not hang past the exit. */
  fail: (error: Error) => void
  end: () => void
}

/** The rejection an abandoned frame carries when nothing else has named a cause yet. */
const UNWRITTEN_FRAME_MESSAGE = 'claude stream-json input ended before the frame was written'

export function createClaudeUserMessageQueue(): ClaudeUserMessageQueue {
  const queued: QueuedMessage[] = []
  // The frame the SDK has taken but not yet acknowledged. It is out of `queued`,
  // so it is unreachable from anywhere else and would otherwise never settle.
  let inFlight: QueuedMessage | null = null
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
        let written = false
        try {
          yield next.message
          written = true
        } finally {
          // The SDK's input pump abandons this iterator when its
          // `await transport.write(...)` rejects or the query aborts, and the code
          // after a `yield` never runs on that path. Settling here is the only
          // place a frame it already took can be reached.
          if (written) {
            inFlight = null
            // Resumed only after the SDK's `await transport.write(...)` settled, so this
            // is the same "the frame reached the child" proof the hand-rolled write gave.
            next.resolve()
          } else {
            rejectInFlight(failure ?? new Error(UNWRITTEN_FRAME_MESSAGE))
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
    push: (message) =>
      new Promise<void>((resolve, reject) => {
        if (failure) {
          reject(failure)
          return
        }
        queued.push({ message, resolve, reject })
        notify()
      }),
    fail: (error) => {
      failure ??= error
      for (const entry of queued.splice(0)) {
        entry.reject(error)
      }
      // A pump that never resumes cannot run the generator's cleanup, so the
      // exit path has to reach the in-flight frame itself.
      rejectInFlight(error)
      notify()
    },
    end: () => {
      ended = true
      notify()
    }
  }
}
