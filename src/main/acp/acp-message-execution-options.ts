import { providerDiagnostic, withProviderDiagnostic } from '../../shared/agent-session-failure'
import type { AgentSessionExecutionOptions } from '../../shared/agent-session-execution-options'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { AcpAgentError } from './acp-errors'
import type { AcpStructuredSession } from './acp-structured-session'
import { acpPromptErrorDetail } from './acp-turn-failures'

export async function applyAcpMessageOptions(
  session: AcpStructuredSession,
  options: AgentSessionExecutionOptions | undefined,
  setOption: (key: 'model' | 'effort', value: string) => Promise<unknown>,
  isCurrent: () => boolean,
  signal?: AbortSignal
): Promise<boolean> {
  if (!options) {
    return true
  }
  for (const key of ['model', 'effort'] as const) {
    const value = options[key]
    if (value === undefined || session.options.appliedInput.get(key) === value) {
      continue
    }
    try {
      await setOption(key, value)
    } catch (error) {
      signal?.throwIfAborted()
      if (!isCurrent()) {
        return false
      }
      if (error instanceof AcpAgentError) {
        throw withProviderDiagnostic(
          new AgentSessionOptionRejectedError(error),
          providerDiagnostic(acpPromptErrorDetail(session.spec.dialect, error), 'person')
        )
      }
      throw new AgentSessionOptionRejectedError(error)
    }
    if (!isCurrent()) {
      return false
    }
  }
  return true
}
