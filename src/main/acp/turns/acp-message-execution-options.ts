import {
  agentSessionFailureFact,
  providerDiagnostic,
  withProviderDiagnostic
} from '../../../shared/agent-session/failures/agent-session-failure'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session/options/protocol/agent-session-execution-options'
import { AgentSessionOptionRejectedError } from '../../native-chat/agent-session-wire/options/structured-agent-session-option-error'
import { compareAppVersions } from '../../../shared/app-lifecycle/identity/app-version'
import { AcpAgentError } from '../transport/acp-errors'
import { cursorParameterizedSelection } from '../acp-dialects/cursor-model-selection'
import { AcpModelCommandRefusedError } from './acp-model-command'
import type { AcpStructuredSession } from '../session/acp-structured-session-contract'
import {
  acpAuthenticationRequired,
  acpPromptErrorDetail,
  acpSignInRequiredFailure
} from './acp-prompt-failure'

export async function applyAcpMessageOptions(
  session: AcpStructuredSession,
  options: AgentSessionExecutionOptions | undefined,
  setOption: (
    key: 'interactionMode' | 'model' | 'effort' | 'fastMode' | 'context',
    value: string
  ) => Promise<unknown>,
  isCurrent: () => boolean,
  signal?: AbortSignal,
  /** The agent's own model command when its model option is absent or rejects the value. */
  modelCommand?: (value: string) => Promise<void>
): Promise<boolean> {
  if (!options) {
    return true
  }
  // Cursor's picker stores a CLI variant (`grok-4.7-high`). The session accepts only the base model.
  const expanded =
    session.spec.agent === 'cursor' && options.model
      ? cursorParameterizedSelection(options.model, session.options.modelChoiceValues())
      : null
  const resolved: AgentSessionExecutionOptions = expanded
    ? {
        ...options,
        model: expanded.model,
        ...(options.effort || !expanded.effort ? {} : { effort: expanded.effort }),
        ...(options.fastMode || !expanded.fastMode ? {} : { fastMode: expanded.fastMode })
      }
    : options
  for (const key of ['interactionMode', 'model', 'effort', 'fastMode', 'context'] as const) {
    const value = resolved[key]
    if (
      value === undefined ||
      (key === 'interactionMode'
        ? !session.options.needsInteractionMode(value)
        : session.options.appliedInput.get(key) === value ||
          (key === 'fastMode' || key === 'context'
            ? !session.options.write(key, value)
            : session.options.matchesNativeRestoredOption(key, value) ||
              (key === 'effort' && !session.options.offersEffort(value))))
    ) {
      continue
    }
    try {
      if (key === 'model' && !session.options.write(key, value)) {
        if (!modelCommand) {
          continue
        }
        await modelCommand(value)
      } else {
        await setOption(key, value).catch((error: unknown) =>
          key === 'model' &&
          modelCommand &&
          error instanceof AcpAgentError &&
          session.spec.dialect.modelCommand?.refusedByOption(error) &&
          isCurrent()
            ? modelCommand(value)
            : Promise.reject(error)
        )
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (!isCurrent()) {
        return false
      }
      if (error instanceof AgentSessionOptionRejectedError) {
        throw error
      }
      if (error instanceof AcpModelCommandRefusedError) {
        throw modelCommandRefusal(error, value, await acpAgentUpdate(session))
      }
      if (error instanceof AcpAgentError) {
        const detail = acpPromptErrorDetail(session.spec.dialect, error)
        const rejection = acpAuthenticationRequired(session.spec.dialect, error)
          ? acpSignInRequiredFailure(session.spec.dialect, error)
          : undefined
        throw withProviderDiagnostic(
          new AgentSessionOptionRejectedError(error, 'optionRejected', rejection),
          providerDiagnostic(detail, 'person')
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

/** Orca's own words name the agent and the next step; the agent's reply stays a diagnostic. */
function modelCommandRefusal(
  error: AcpModelCommandRefusedError,
  value: string,
  agentUpdate: string | undefined
): Error {
  const { refused, detail } = error.reply
  const fact =
    refused === 'notSignedIn'
      ? agentSessionFailureFact('notSignedIn')
      : agentSessionFailureFact('modelUnavailable', {
          detail: providerDiagnostic(value, 'log'),
          ...(agentUpdate ? { agentUpdate } : {})
        })
  return withProviderDiagnostic(
    new AgentSessionOptionRejectedError(error, 'optionRejected', fact),
    providerDiagnostic(detail, 'log')
  )
}

/** The release to update to, when the running agent reports one older than its command needs. */
async function acpAgentUpdate(session: AcpStructuredSession): Promise<string | undefined> {
  const needed = session.spec.dialect.modelCommand?.resolvesSelectorsFrom
  const running = needed
    ? (await session.connection.initialize().catch(() => null))?.agentInfo?.version
    : undefined
  return needed && running && compareAppVersions(running, needed) < 0 ? needed : undefined
}
