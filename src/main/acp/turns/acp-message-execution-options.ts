import {
  agentSessionFailureFact,
  providerDiagnostic,
  withProviderDiagnostic
} from '../../../shared/agent-session/failures/agent-session-failure'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session/options/protocol/agent-session-execution-options'
import { AgentSessionOptionRejectedError } from '../../native-chat/agent-session-wire/options/structured-agent-session-option-error'
import { compareAppVersions } from '../../../shared/app-lifecycle/identity/app-version'
import { AcpAgentError } from '../transport/acp-errors'
import { AcpModelCommandRefusedError } from './acp-model-command'
import type { AcpStructuredSession } from '../session/acp-structured-session-contract'
import type { AcpListedChatModel } from '../acp-dialects/acp-dialect'
import {
  acpAuthenticationRequired,
  acpPromptErrorDetail,
  acpSignInRequiredFailure
} from './acp-prompt-failure'

export async function applyAcpMessageOptions(
  session: AcpStructuredSession,
  requested: AgentSessionExecutionOptions | undefined,
  setOption: (
    key: 'interactionMode' | 'model' | 'thinking' | 'effort' | 'fastMode',
    value: string
  ) => Promise<unknown>,
  isCurrent: () => boolean,
  signal?: AbortSignal,
  /** The agent's own model command when its model option is absent or rejects the value. */
  modelCommand?: (value: string) => Promise<void>
): Promise<boolean> {
  if (!requested) {
    return true
  }
  const options = withListedModel(session, requested)
  // Thinking precedes effort, so a model's effort is set on the thinking mode it runs.
  for (const key of ['interactionMode', 'model', 'thinking', 'effort', 'fastMode'] as const) {
    const value = key === 'effort' ? offeredEffort(session, options.effort) : options[key]
    if (
      value === undefined ||
      (key === 'interactionMode'
        ? !session.options.needsInteractionMode(value)
        : session.options.appliedInput.get(key) === value ||
          (key === 'fastMode' || key === 'thinking'
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

/** An unlisted CLI model id becomes the listed model it names; explicit effort and Fast still
 *  win. An id naming none is sent as is, so the agent refuses it. */
function withListedModel(
  session: AcpStructuredSession,
  options: AgentSessionExecutionOptions
): AgentSessionExecutionOptions & Partial<Pick<AcpListedChatModel, 'thinking'>> {
  const { model, ...rest } = options
  const { chatModelIds, unlistedChatModel } = session.spec.dialect
  // A model this session already applied is listed.
  if (!unlistedChatModel || !model || session.options.appliedInput.get('model') === model) {
    return options
  }
  const listed = session.options.read().models.map((entry) => entry.id)
  if (listed.includes(chatModelIds?.get(model) ?? model)) {
    return options
  }
  const named = unlistedChatModel(model, listed)
  return named
    ? {
        ...rest,
        model: named.model,
        thinking: named.thinking,
        effort: rest.effort ?? named.effort,
        fastMode: rest.fastMode ?? named.fastMode
      }
    : options
}

/** The running model's own spelling of an effort it lists under another name. */
function offeredEffort(session: AcpStructuredSession, effort: string | undefined) {
  const alias = effort && session.spec.dialect.chatEffortIds?.get(effort)
  return alias && !session.options.offersEffort(effort) && session.options.offersEffort(alias)
    ? alias
    : effort
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
