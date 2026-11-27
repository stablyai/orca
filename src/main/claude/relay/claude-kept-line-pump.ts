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
  let draining: Promise<void> = Promise.resolve()

  const pump = (): Promise<void> => {
    draining = draining.then(async () => {
      while (!stopped && head < lines.length) {
        await input.paused()
        if (stopped) {
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
    /** The agent exited: its last partial line counts. */
    finish(): Promise<void> {
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
