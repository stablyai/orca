// A fake adapter's children prove their start once published, except those a test holds `starting`.

import type {
  StructuredAgentSessionAdapter,
  StructuredAgentSessionLifecycleEvent
} from './structured-agent-session-adapter'

type Acquire = StructuredAgentSessionAdapter['acquire']

/** A report read at this revision is never admitted, so the empty report persists nothing. */
const NO_OPTIONS_REPORTED = -1

export type StructuredAgentSessionHeldStarts = {
  /** Wraps an acquire so the child it answers stays `starting`. */
  held(acquire: Acquire): Acquire
  /** Wraps the adapter's acquire: every child not held proves its start once published. */
  wrap<A extends StructuredAgentSessionAdapter>(adapter: A): A
  /** Settles `started` for a child, as its provider answering the handshake does. */
  prove(child: { sessionId: string; fence: number; acquisitionGeneration: string }): Promise<void>
  clear(): void
}

export function structuredAgentSessionHeldStarts(
  host: () => { handleAdapterEvent(event: StructuredAgentSessionLifecycleEvent): Promise<void> }
): StructuredAgentSessionHeldStarts {
  const heldGenerations = new Set<string>()
  let generations = 0
  const prove: StructuredAgentSessionHeldStarts['prove'] = (child) =>
    host().handleAdapterEvent({
      type: 'started',
      ...child,
      reportedOptions: { model: '' },
      restoreSkippedOptions: [],
      optionRevision: NO_OPTIONS_REPORTED
    })
  return {
    held: (acquire) => async (input) => {
      const acquired = await acquire(input)
      const acquisitionGeneration = acquired.acquisitionGeneration ?? `held-start-${++generations}`
      heldGenerations.add(acquisitionGeneration)
      return { ...acquired, acquisitionGeneration }
    },
    wrap: (adapter) => {
      const acquire: Acquire = async (input) => {
        const acquired = await adapter.acquire(input)
        const acquisitionGeneration =
          acquired.acquisitionGeneration ?? `instant-start-${++generations}`
        if (!heldGenerations.has(acquisitionGeneration)) {
          void prove({
            sessionId: input.identity.sessionId,
            fence: input.fence,
            acquisitionGeneration
          })
        }
        return { ...acquired, acquisitionGeneration }
      }
      return { ...adapter, acquire }
    },
    prove,
    clear: () => heldGenerations.clear()
  }
}
