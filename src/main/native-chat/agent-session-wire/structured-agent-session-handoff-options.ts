import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { encodeStructuredAgentSessionOptionValue } from '../../../shared/structured-agent-session-option-codec'

export async function readNativeHandoffSessionOptions(input: {
  adapter: Pick<StructuredAgentSessionAdapter, 'readOptions'>
  sessionId: string
  fence: number
  priorOptions?: Readonly<Record<string, string>>
}): Promise<Readonly<Record<string, string>> | undefined> {
  const { adapter, sessionId, fence, priorOptions } = input
  const reported = await adapter.readOptions?.({
    sessionId,
    fence
  })
  if (!reported) {
    return undefined
  }
  const { model: _model, effort: _effort, fastMode: _fastMode, ...restored } = priorOptions ?? {}
  const fastMode =
    reported.current.fastMode === undefined
      ? undefined
      : encodeStructuredAgentSessionOptionValue('fastMode', reported.current.fastMode)
  return {
    ...restored,
    model: reported.current.model,
    ...(reported.current.effort ? { effort: reported.current.effort } : {}),
    ...(fastMode !== undefined && fastMode !== null ? { fastMode } : {})
  }
}
