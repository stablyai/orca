import type { AgentSessionOptionsResult } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { encodeStructuredAgentSessionOptionValue } from '../../../shared/structured-agent-session-option-codec'

export async function readNativeSessionOptions(input: {
  adapter: Pick<StructuredAgentSessionAdapter, 'readOptions' | 'readOptionRestoreFailures'>
  sessionId: string
  fence: number
  priorOptions?: Readonly<Record<string, string>>
}): Promise<Readonly<Record<string, string>> | undefined> {
  const { adapter, sessionId, fence, priorOptions } = input
  const reported = await adapter.readOptions?.({ sessionId, fence })
  if (!reported) {
    return undefined
  }
  return nativeSessionOptionsFromReport({
    reported: reported.current,
    restoreSkipped: adapter.readOptionRestoreFailures?.(sessionId) ?? [],
    ...(priorOptions ? { priorOptions } : {})
  })
}

/** The record's options once the provider has reported: its model, effort and Fast replace the
 *  saved ones, other saved options stay, and any the child could not take are dropped. */
export function nativeSessionOptionsFromReport(input: {
  reported: AgentSessionOptionsResult['current']
  restoreSkipped: readonly string[]
  priorOptions?: Readonly<Record<string, string>>
  /** Values the child showed it cannot run: its report of the same value is not kept. */
  retired?: Readonly<Record<string, string>>
}): Readonly<Record<string, string>> {
  const { reported, priorOptions } = input
  const restored = priorOptions ? { ...priorOptions } : {}
  delete restored.model
  delete restored.effort
  delete restored.fastMode
  for (const key of input.restoreSkipped) {
    delete restored[key]
  }
  const fastMode =
    reported.fastMode === undefined
      ? undefined
      : encodeStructuredAgentSessionOptionValue('fastMode', reported.fastMode)
  const options: Record<string, string> = {
    ...restored,
    model: reported.model,
    ...(reported.effort ? { effort: reported.effort } : {}),
    ...(fastMode !== undefined && fastMode !== null ? { fastMode } : {})
  }
  for (const [key, value] of Object.entries(input.retired ?? {})) {
    if (options[key] === value) {
      delete options[key]
    }
  }
  return options
}
