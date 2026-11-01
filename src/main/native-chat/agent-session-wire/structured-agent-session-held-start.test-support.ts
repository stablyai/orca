import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

type Acquire = StructuredAgentSessionAdapter['acquire']
type Open = StructuredAgentSessionAdapter['open']

export type StructuredAgentSessionHeldStarts = {
  held(acquire: Acquire): Acquire
  wrap<A extends StructuredAgentSessionAdapter>(adapter: A): A & StructuredAgentSessionAdapter
  prove(child: { sessionId: string; fence: number; acquisitionGeneration: string }): Promise<void>
  clear(): void
}

export function structuredAgentSessionHeldStarts(
  _host: () => unknown
): StructuredAgentSessionHeldStarts {
  const held = new Map<string, () => void>()
  const waiting = new Map<string, Promise<void>>()
  const prove: StructuredAgentSessionHeldStarts['prove'] = async (child) => {
    held.get(child.acquisitionGeneration)?.()
    await Promise.resolve()
  }
  return {
    held: (acquire) => async (input) => {
      const acquired = await acquire(input)
      const generation = acquired.acquisitionGeneration
      waiting.set(generation, new Promise<void>((resolve) => held.set(generation, resolve)))
      return acquired
    },
    wrap: (adapter) => {
      const open: Open = async (input) => {
        const generation = input.acquisitionGeneration
        if (generation) {
          await waiting.get(generation)
          waiting.delete(generation)
          held.delete(generation)
        }
        return adapter.open(input)
      }
      return { ...adapter, open }
    },
    prove,
    clear: () => {
      for (const resolve of held.values()) {
        resolve()
      }
      held.clear()
      waiting.clear()
    }
  }
}
