import { dispatchClaudeTurn } from './claude-structured-dispatch'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AgentSessionExecutionOptions } from '../../shared/agent-session-execution-options'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { listedModels } from './claude-structured-model-catalog'
import { setClaudeStructuredOption } from './claude-structured-options'
import type { ClaudeSession } from './claude-structured-session-state'
import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../shared/abort-signal-reason'

/** Applies the accepted message's choices while its prompt is still in the SDK input queue. */
export async function applyClaudeMessageOptions(
  session: ClaudeSession,
  options: AgentSessionExecutionOptions,
  timeoutMs: number | undefined,
  signal?: AbortSignal
): Promise<void> {
  throwIfSignalAborted(signal)
  const model = options.model ?? (await defaultModelForMessage(session, timeoutMs, signal))
  if (model && session.reusableOptions.get('model') !== model) {
    await waitForPromiseWithSignal(
      setClaudeStructuredOption(session, { key: 'model', value: model }, timeoutMs),
      signal
    )
  }

  throwIfSignalAborted(signal)
  const effort = options.effort ?? session.configuredDefaults?.effort
  if (effort && session.reusableOptions.get('effort') !== effort) {
    await waitForPromiseWithSignal(
      setClaudeStructuredOption(session, { key: 'effort', value: effort }, timeoutMs),
      signal
    )
  } else if (!effort && session.options.has('effort')) {
    throw new AgentSessionOptionRejectedError('Claude did not report its configured effort')
  }

  throwIfSignalAborted(signal)
  const fastMode = options.fastMode
  if (fastMode !== undefined && session.reusableOptions.get('fastMode') !== fastMode) {
    await waitForPromiseWithSignal(
      setClaudeStructuredOption(session, { key: 'fastMode', value: fastMode }, timeoutMs),
      signal
    )
  }
  for (const [key, value] of Object.entries({ model, effort, fastMode })) {
    if (value !== undefined && session.reusableOptions.get(key) !== value) {
      throw new AgentSessionOptionRejectedError(`Claude did not apply ${key} ${value}`)
    }
  }
  throwIfSignalAborted(signal)
}

async function defaultModelForMessage(
  session: ClaudeSession,
  timeoutMs: number | undefined,
  signal?: AbortSignal
): Promise<string | undefined> {
  if (session.configuredDefaults?.model) {
    return session.configuredDefaults.model
  }
  if (!session.options.has('model')) {
    return undefined
  }
  const response = await waitForPromiseWithSignal(
    session.connection.supportedModels({ timeoutMs }),
    signal
  ).catch(() => null)
  throwIfSignalAborted(signal)
  const listed = listedModels(response ? { models: response } : null)
  const fallback = listed.find((model) => model.isDefault)?.id
  if (!fallback) {
    throw new AgentSessionOptionRejectedError('Claude did not report its default model')
  }
  return fallback
}

/** What the turn runs on, from the CLI's own answers: the message's choices it applied, and the
 *  effort the CLI resolved for the model it applies (never the settings level alone). */
function claudeRanOptions(
  session: ClaudeSession,
  options: AgentSessionExecutionOptions
): Record<string, string> {
  const resolvedHere = options.model === undefined || options.model === session.launchedModel
  const ran = {
    model: options.model,
    effort: options.effort ?? (resolvedHere ? session.configuredDefaults?.effort : undefined),
    fastMode: options.fastMode
  }
  return Object.fromEntries(
    Object.entries(ran).flatMap(([key, value]) =>
      value !== undefined && session.reusableOptions.get(key) === value ? [[key, value]] : []
    )
  )
}

export async function dispatchClaudeMessage(
  session: ClaudeSession,
  input: Parameters<StructuredAgentSessionAdapter['dispatch']>[0],
  timeoutMs: number | undefined
): ReturnType<StructuredAgentSessionAdapter['dispatch']> {
  const messageOptions = input.executionOptions
  const outcome = await dispatchClaudeTurn(
    session,
    input,
    messageOptions === undefined
      ? input.beforeDispatch
      : async () => {
          await input.beforeDispatch?.()
          try {
            await applyClaudeMessageOptions(session, messageOptions, timeoutMs, input.signal)
            input.signal?.throwIfAborted()
          } catch (error) {
            throw error instanceof AgentSessionOptionRejectedError
              ? error
              : new AgentSessionOptionRejectedError(error)
          }
        }
  )
  // Always, even empty: the settings effort the CLI reports is never evidence of a run.
  return outcome.state === 'accepted' || outcome.state === 'admitted'
    ? { ...outcome, ranOptions: claudeRanOptions(session, messageOptions ?? {}) }
    : outcome
}
