// A bound on how long teardown may take, expressed as a wrapper around the eviction steps rather
// than a change to them.
//
// The step list is ordered and abort-on-failure for reasons that have nothing to do with time, and
// a deadline must not disturb either. Wrapping each step's `run` keeps the order, and a timeout
// surfaces as that step failing — which is exactly the behavior wanted here: the rest of the
// eviction aborts, the session stays indexed, and the child stays LOADED. A stuck app-server that
// is still holding a conversation is a better outcome than one killed out from under it; the next
// close retries.

import type { StructuredAgentSessionEvictionStep } from './structured-agent-session-eviction'

export const STRUCTURED_AGENT_SESSION_EVICTION_STEP_TIMEOUT_MS = 10_000

export class StructuredAgentSessionEvictionTimeoutError extends Error {
  constructor(
    readonly step: string,
    readonly timeoutMs: number
  ) {
    super(`agent session eviction step "${step}" did not finish within ${timeoutMs}ms`)
    this.name = 'StructuredAgentSessionEvictionTimeoutError'
  }
}

export function withStructuredAgentSessionEvictionDeadline(
  steps: readonly StructuredAgentSessionEvictionStep[],
  timeoutMs = STRUCTURED_AGENT_SESSION_EVICTION_STEP_TIMEOUT_MS
): readonly StructuredAgentSessionEvictionStep[] {
  return steps.map((step) => ({
    name: step.name,
    run: async (context) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.resolve(step.run(context)),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new StructuredAgentSessionEvictionTimeoutError(step.name, timeoutMs)),
              timeoutMs
            )
            timer.unref?.()
          })
        ])
      } finally {
        if (timer) {
          clearTimeout(timer)
        }
      }
    }
  }))
}
