// Ways a test holds a session's work at a chosen step, so a Stop or close asked for meanwhile runs
// in a known order against the delivery loop's handover.

import { vi } from 'vitest'
import { StructuredAgentSessionDeliveryLoop } from './structured-agent-session-delivery-loop'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'

/** Holds the delivery loop's next step as it begins, inside the session's lane, until `release`:
 *  a Stop or close asked for meanwhile runs ahead of the handover. `held` resolves once the step
 *  has reached the hold. */
export function holdDelivery(): { held: Promise<void>; release: () => void } {
  const gate = Promise.withResolvers<void>()
  const reached = Promise.withResolvers<void>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `prepare` is a prototype method whose privacy is compile-time only; the spy calls it unchanged.
  const loop = StructuredAgentSessionDeliveryLoop.prototype as unknown as {
    prepare: (...args: unknown[]) => Promise<unknown>
  }
  const prepare = loop.prepare
  const step = vi.spyOn(loop, 'prepare').mockImplementation(async function (
    this: unknown,
    ...args: unknown[]
  ) {
    step.mockRestore()
    reached.resolve()
    await gate.promise
    return prepare.apply(this, args)
  })
  return { held: reached.promise, release: () => gate.resolve() }
}

/** Holds the session's lane until the returned release: whatever is asked for meanwhile runs in
 *  the order it was asked, ahead of a handover the delivery loop asks for after it. */
export function holdLane(host: StructuredAgentSessionHost, sessionId: string): () => void {
  const held = Promise.withResolvers<void>()
  void host['tasks'].serialize(sessionId, () => held.promise)
  return () => held.resolve()
}
