// A fake adapter's children prove their start once published, except those a test holds `starting`.

import type {
  StructuredAgentSessionAdapter,
  StructuredAgentSessionLifecycleEvent
} from './structured-agent-session-adapter'

type Acquire = StructuredAgentSessionAdapter['acquire']

export type StructuredAgentSessionHeldStarts = {
  /** Wraps an acquire so the child it answers stays `starting`. */
  held(acquire: Acquire): Acquire
  /** Wraps the adapter's acquire: every child not held proves its start once published. */
  wrap<A extends StructuredAgentSessionAdapter>(adapter: A): A
  /** Answers the pending protocol open. */
  prove(child: { sessionId: string; fence: number; acquisitionGeneration: string }): Promise<void>
  clear(): void
}

export function structuredAgentSessionHeldStarts(
  _host: () => { handleAdapterEvent(event: StructuredAgentSessionLifecycleEvent): Promise<void> }
): StructuredAgentSessionHeldStarts {
  const heldGenerations = new Map<string, PromiseWithResolvers<void>>()
  let generations = 0
  const prove: StructuredAgentSessionHeldStarts['prove'] = async (child) => {
    heldGenerations.get(child.acquisitionGeneration)?.resolve()
    await Promise.resolve()
  }
  return {
    held: (acquire) => async (input) => {
      const acquired = await acquire(input)
      const acquisitionGeneration = acquired.acquisitionGeneration ?? `held-start-${++generations}`
      heldGenerations.set(acquisitionGeneration, Promise.withResolvers<void>())
      return { ...acquired, acquisitionGeneration, providerChildPhase: 'starting' as const }
    },
    wrap: (adapter) => {
      const acquire: Acquire = async (input) => {
        const acquired = await adapter.acquire(input)
        const acquisitionGeneration =
          acquired.acquisitionGeneration ?? `instant-start-${++generations}`
        return { ...acquired, acquisitionGeneration, providerChildPhase: 'starting' as const }
      }
      const open: NonNullable<StructuredAgentSessionAdapter['open']> = async (input) => {
        if (input.acquisitionGeneration) {
          await heldGenerations.get(input.acquisitionGeneration)?.promise
          heldGenerations.delete(input.acquisitionGeneration)
        }
        return adapter.open
          ? adapter.open(input)
          : {
              reportedOptions: { model: '' }
            }
      }
      return { ...adapter, acquire, open }
    },
    prove,
    clear: () => {
      for (const held of heldGenerations.values()) {
        held.resolve()
      }
      heldGenerations.clear()
    }
  }
}
