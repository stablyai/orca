// Fake children answer the host-awaited protocol open immediately.

import type {
  StructuredAgentSessionAdapter,
  StructuredAgentSessionLifecycleEvent
} from './structured-agent-session-adapter'

export function startsWhenPublished<A extends StructuredAgentSessionAdapter>(
  adapter: A,
  _host: () => { handleAdapterEvent(event: StructuredAgentSessionLifecycleEvent): Promise<void> }
): A {
  let generations = 0
  const acquire: StructuredAgentSessionAdapter['acquire'] = async (input) => {
    const acquired = await adapter.acquire(input)
    const acquisitionGeneration = acquired.acquisitionGeneration ?? `instant-start-${++generations}`
    return { ...acquired, acquisitionGeneration, providerChildPhase: 'starting' as const }
  }
  return {
    ...adapter,
    acquire,
    open:
      adapter.open ??
      (async () => ({
        reportedOptions: { model: '' }
      }))
  }
}
