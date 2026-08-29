import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

export async function readNativeSessionOptions(input: {
  adapter: Pick<StructuredAgentSessionAdapter, 'readOptions'>
  sessionId: string
  fence: number
  priorOptions?: Readonly<Record<string, string>>
}): Promise<Readonly<Record<string, string>> | undefined> {
  const { adapter, sessionId, fence, priorOptions } = input
  const reported = await adapter.readOptions?.({ sessionId, fence })
  if (!reported) {
    return undefined
  }
  const { model: _model, effort: _effort, ...restored } = priorOptions ?? {}
  return {
    ...restored,
    model: reported.current.model,
    ...(reported.current.effort ? { effort: reported.current.effort } : {})
  }
}
