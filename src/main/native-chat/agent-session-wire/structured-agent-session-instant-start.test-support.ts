import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

type InstantStartAdapter = Omit<StructuredAgentSessionAdapter, 'open'> &
  Partial<Pick<StructuredAgentSessionAdapter, 'open'>>

export function startsWhenPublished<A extends InstantStartAdapter>(
  adapter: A,
  _host: () => unknown
): A & StructuredAgentSessionAdapter {
  const acquire: StructuredAgentSessionAdapter['acquire'] = async (input) => {
    const acquired = await adapter.acquire(input)
    if (!acquired.acquisitionGeneration) {
      throw new Error('test provider did not publish its generation')
    }
    return acquired
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
