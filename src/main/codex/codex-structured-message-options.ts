import type { AgentSessionExecutionOptions } from '../../shared/agent-session-execution-options'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { CodexSession } from './codex-structured-session-state'
import { codexSessionCapabilities } from './codex-structured-catalog-entry'
import { codexServiceTierOfFastMode } from './codex-structured-session-options'
import { codexEffectiveModel, codexTurnRequestOptions } from './codex-structured-service-tier'

/** Captured fields are overrides; omitted fields inherit the native thread's state. */
export async function resolvedCodexMessageOptions(
  session: CodexSession,
  choices: AgentSessionExecutionOptions | undefined
): Promise<Readonly<Record<string, string>> | undefined> {
  if (choices === undefined) {
    return undefined
  }
  return compileCodexMessageOptions(session, choices)
}

function compileCodexMessageOptions(
  session: CodexSession,
  choices: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string>> {
  const compiled: Record<string, string> = {}
  for (const key of ['model', 'effort', 'personality', 'serviceTier'] as const) {
    const value = choices[key]
    if (value !== undefined) {
      compiled[key] = value
    }
  }
  if (choices.serviceTier === undefined && choices.fastMode !== undefined) {
    const model = codexSessionCapabilities(session).models.find(
      (row) => row.id === codexEffectiveModel(session, compiled)
    )
    compiled.serviceTier = codexServiceTierOfFastMode(choices.fastMode, model)
  }
  return codexTurnRequestOptions(session, compiled)
}

/** The same sparse controls as dispatch, compared under the exact acquisition that took them. */
export function readCodexAppliedInputOptions(
  session: CodexSession | undefined,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['readAppliedInputOptions']>>[0]
): ReturnType<NonNullable<StructuredAgentSessionAdapter['readAppliedInputOptions']>> {
  if (
    !session ||
    session.ended ||
    session.connection.closed ||
    session.fence !== input.fence ||
    session.acquisitionGeneration !== input.acquisitionGeneration ||
    !session.appliedTurnOptions
  ) {
    return null
  }
  const active = session.appliedTurnOptions
  const requested = input.next ?? Object.fromEntries(session.options)
  return { active, next: { ...active, ...compileCodexMessageOptions(session, requested) } }
}
