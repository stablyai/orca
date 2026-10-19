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

export function dispatchClaudeMessage(
  session: ClaudeSession,
  input: Parameters<StructuredAgentSessionAdapter['dispatch']>[0],
  timeoutMs: number | undefined
): ReturnType<StructuredAgentSessionAdapter['dispatch']> {
  const messageOptions = input.executionOptions
  return dispatchClaudeTurn(
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
}
