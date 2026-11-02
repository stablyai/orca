import {
  readyConstruction,
  normalizeConstruction,
  type ConstructionStep
} from './structured-agent-session-construction'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

type InstantStartAdapter = Omit<StructuredAgentSessionAdapter, 'open'> &
  Partial<Pick<StructuredAgentSessionAdapter, 'open'>>

export function startsWhenPublished<A extends InstantStartAdapter>(
  adapter: A,
  _host: () => unknown
): A & StructuredAgentSessionAdapter {
  const acquire: StructuredAgentSessionAdapter['acquire'] = async (input) => {
    const acquired = normalizeConstruction(await adapter.acquire(input))
    if (acquired.kind === 'ready' && !acquired.value.acquisitionGeneration) {
      throw new Error('test provider did not publish its generation')
    }
    return acquired
  }
  return {
    ...adapter,
    acquire,
    open:
      adapter.open ??
      (async () =>
        readyConstruction({
          reportedOptions: { model: '' }
        }))
  }
}

export function readyConstructionValue<T extends object>(value: T | ConstructionStep<T>): T {
  const step = normalizeConstruction(value)
  if (step.kind !== 'ready') {
    throw new Error('This fixture requires available native history')
  }
  return step.value
}
