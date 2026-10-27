import { vi } from 'vitest'
import { StructuredAgentSessionDeliveryLoop } from './structured-agent-session-delivery-loop'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'

/** Hold preparation so Stop/close queues before handover; held confirms the gate was reached. */
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

/** Hold serialization so intervening operations queue before delivery handover. */
export function holdLane(host: StructuredAgentSessionHost, sessionId: string): () => void {
  const held = Promise.withResolvers<void>()
  void host['tasks'].serialize(sessionId, () => held.promise)
  return () => held.resolve()
}
