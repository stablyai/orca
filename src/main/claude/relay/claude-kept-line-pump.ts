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
  /** Bounds the one pause wait under way (drains run one at a time) once the agent exits. */
  let bound: (() => void) | undefined
  let draining: Promise<void> = Promise.resolve()

  // From the exit on, even for a wait begun before it, a pause that never lifts (a failed journal
  // read keeps its hold) gives up the rest, untaken: the chat recovers it from Claude's transcript.
  const waitHold = (held: Promise<void>): Promise<boolean> => {
    // A hold that rejects is gone as surely as one that lifts.
    const pause = held.then(
      () => true,
      () => true
    )
    if (final) {
      return withTimeout(pause, FINAL_DRAIN_PAUSE_WAIT_MS, false)
    }
    return new Promise<boolean>((resolve) => {
      bound = () => void withTimeout(pause, FINAL_DRAIN_PAUSE_WAIT_MS, false).then(resolve)
      void pause.then((lifted) => {
        bound = undefined
        resolve(lifted)
      })
    })
  }

  /** Ends delivery: the lines not handed on stay untaken (never acked), and none are kept. */
  const end = (): void => {
    stopped = true
    lines = []
    head = 0
  }

  const pump = (): Promise<void> => {
    draining = draining.then(async () => {
      while (!stopped && head < lines.length) {
        // Every pause until none is held, checked with no await before the delivery below: a new
        // one can be put in place after the last lifted.
        let gaveUp = false
        for (let held = input.paused(); held && !stopped; held = input.paused()) {
          if (!(await waitHold(held))) {
            gaveUp = true
            break
          }
        }
        if (gaveUp || stopped) {
          end()
          break
        }
        try {
          input.deliver(lines[head])
        } catch (error) {
          end()
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
      if (stopped) {
        return
      }
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
      bound?.()
      if (partial.length > 0) {
        lines.push(partial)
        partial = ''
      }
      return pump()
    },
    /** Nothing more is delivered (the connection ended). */
    stop(): void {
      end()
    }
  }
}
