import { withTimeout } from '../../../shared/concurrency/promise-timeout-fallback'

/** How long the drain at the agent's exit waits on a reading pause before it gives up. */
const FINAL_DRAIN_PAUSE_WAIT_MS = 5_000

/**
 * The kept agent's stdout lines, handed to the chat in order, one drain at a time, so lines keep
 * their order across a paused read. No timer may run while lines wait here: an ack then would
 * cover output the chat never got. A line counts as taken only once it was delivered.
 */
export function createClaudeKeptLinePump(input: {
  deliver: (line: string) => void
  /** One line delivered: acks may cover it. */
  taken: () => void
  /** A reading pause the drain waits on, if one is held. */
  paused: () => Promise<void> | undefined
  /** Delivery threw: the line stays untaken (never acked) and nothing after it is delivered. */
  failed: (error: unknown) => void
}) {
  // A head index, not shift(): a replay can be tens of thousands of lines.
  let lines: string[] = []
  let head = 0
  let partial = ''
  let stopped = false
  /** The agent exited: a pause that never lifts must not hold its exit. */
  let final = false
  let draining: Promise<void> = Promise.resolve()

  // At exit, a pause that never lifts (a failed journal read keeps its hold) gives up the rest,
  // untaken: the chat recovers it from Claude's transcript.
  const waitPause = (): Promise<boolean> => {
    const pause = input.paused()?.then(() => true)
    if (!pause) {
      return Promise.resolve(true)
    }
    return final ? withTimeout(pause, FINAL_DRAIN_PAUSE_WAIT_MS, false) : pause
  }

  const pump = (): Promise<void> => {
    draining = draining.then(async () => {
      while (!stopped && head < lines.length) {
        if (!(await waitPause()) || stopped) {
          stopped = true
          break
        }
        try {
          input.deliver(lines[head])
        } catch (error) {
          stopped = true
          input.failed(error)
          break
        }
        head += 1
        input.taken()
      }
      if (head >= lines.length) {
        lines = []
        head = 0
      }
    })
    return draining
  }

  return {
    push(chunk: string): void {
      const parts = (partial + chunk).split('\n')
      partial = parts.pop() ?? ''
      for (const part of parts) {
        if (part.length > 0) {
          lines.push(part)
        }
      }
      void pump()
    },
    pump,
    /** The agent exited: its last partial line counts, and a held pause is waited on only so long. */
    finish(): Promise<void> {
      final = true
      if (partial.length > 0) {
        lines.push(partial)
        partial = ''
      }
      return pump()
    },
    /** Nothing more is delivered (the connection ended). */
    stop(): void {
      stopped = true
    }
  }
}
