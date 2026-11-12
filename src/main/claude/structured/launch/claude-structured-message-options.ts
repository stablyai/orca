import { claudeBuildPermissionMode } from '../permissions/claude-plan-approval-mode'
import { claudeStartedUnechoedSend } from '../turns/claude-command-lifecycle'
import { claudeExecutionObservations } from '../claude-structured-execution-observations'
import { dispatchClaudeTurn } from '../claude-structured-dispatch'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { AgentSessionExecutionOptions } from '../../../../shared/agent-session/options/agent-session-execution-options'
import { AgentSessionOptionRejectedError } from '../../../native-chat/agent-session-wire/options/structured-agent-session-option-error'
import { StructuredAgentSessionInputNotAdmitted } from '../../../native-chat/agent-session-wire/delivery/structured-agent-session-input-admission'
import { AgentSessionPreDispatchError } from '../../../native-chat/agent-session-wire/operations/structured-agent-session-operation-settlement'
import {
  createStructuredAgentSessionLogger,
  neverThrowingStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import {
  claudeAppliedEffort,
  claudeTakesFlagSettings,
  setClaudeStructuredOption
} from './claude-structured-options'
import type { ClaudeSession } from '../claude-structured-session-state'
import {
  isAbortSignalReason,
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../../../shared/abort-signal-reason'

const defaultLogger = createStructuredAgentSessionLogger()

export async function applyClaudeMessageOptions(
  session: ClaudeSession,
  options: AgentSessionExecutionOptions,
  timeoutMs: number | undefined,
  signal?: AbortSignal
): Promise<void> {
  throwIfSignalAborted(signal)
  const model = options.model
  // Only a turn carrying the newest pick reports on it; earlier captured sends run the replaced model.
  if (model === session.modelPickAwaitingTurn) {
    delete session.modelPickAwaitingTurn
  }
  if (model && session.appliedInputOptions.get('model') !== model) {
    await waitForPromiseWithSignal(
      setClaudeStructuredOption(session, { key: 'model', value: model }, timeoutMs),
      signal
    )
  }

  throwIfSignalAborted(signal)
  // A restored switch rides the first message even from a client that never offers it.
  const requestedUltracode = options.ultracode ?? session.options.get('ultracode')
  // Saved choices stay saved for a CLI that can apply them; this one runs on its own.
  const takesFlagSettings =
    (options.effort !== undefined ||
      options.fastMode !== undefined ||
      requestedUltracode !== undefined) &&
    (await claudeTakesFlagSettings(session))
  throwIfSignalAborted(signal)
  // Before effort, which keeps Ultracode on only when it knows the switch's new position.
  const ultracode = takesFlagSettings ? requestedUltracode : undefined
  if (ultracode !== undefined && session.appliedInputOptions.get('ultracode') !== ultracode) {
    await waitForPromiseWithSignal(
      setClaudeStructuredOption(session, { key: 'ultracode', value: ultracode }, timeoutMs),
      signal
    )
  }

  throwIfSignalAborted(signal)
  const effort = takesFlagSettings ? options.effort : undefined
  if (effort && !claudeAppliedEffort(session, effort)) {
    await waitForPromiseWithSignal(
      setClaudeStructuredOption(session, { key: 'effort', value: effort }, timeoutMs),
      signal
    )
  }

  throwIfSignalAborted(signal)
  const fastMode = takesFlagSettings ? options.fastMode : undefined
  if (fastMode !== undefined && session.appliedInputOptions.get('fastMode') !== fastMode) {
    await waitForPromiseWithSignal(
      setClaudeStructuredOption(session, { key: 'fastMode', value: fastMode }, timeoutMs),
      signal
    )
  }
  throwIfSignalAborted(signal)
  if (options.interactionMode !== undefined) {
    const mode = options.interactionMode === 'plan' ? 'plan' : claudeBuildPermissionMode(session)
    await waitForPromiseWithSignal(
      session.connection.setPermissionMode(mode, { timeoutMs }),
      signal
    )
    session.appliedInputOptions.set('interactionMode', options.interactionMode)
    if (options.interactionMode === 'default') {
      session.appliedInputOptions.set('buildPermissionMode', mode)
    }
  }
  throwIfSignalAborted(signal)
}

export async function dispatchClaudeMessage(
  session: ClaudeSession,
  input: Parameters<StructuredAgentSessionAdapter['dispatch']>[0],
  timeoutMs: number | undefined,
  logger: StructuredAgentSessionLogger = defaultLogger
): ReturnType<StructuredAgentSessionAdapter['dispatch']> {
  let ranOptions: Record<string, string> = {}
  const outcome = await dispatchClaudeTurn(session, input, async () => {
    try {
      input.signal?.throwIfAborted()
      // Input joining a running turn, and Orca mail notices, run on the choices Claude already has;
      // new choices apply at the next new turn.
      const messageOptions =
        session.translator?.openTurnHasInputWork ||
        session.translator?.commandTurnId ||
        claudeStartedUnechoedSend(session) ||
        input.body.from?.orchestration?.message === 'mail-notice'
          ? undefined
          : input.executionOptions
      input.onInputPreparation?.()
      if (messageOptions !== undefined) {
        await applyClaudeMessageOptions(session, messageOptions, timeoutMs, input.signal)
      }
      input.signal?.throwIfAborted()
      await input.beforeDispatch?.()
      input.onExecutionSnapshot?.()
      ranOptions = claudeExecutionObservations(session)
      if (messageOptions?.model && ranOptions.model !== messageOptions.model) {
        delete ranOptions.model
      }
    } catch (error) {
      neverThrowingStructuredAgentSessionLogger(logger).warn(
        'applying Claude message choices failed',
        {
          scope: 'claude-message-options',
          sessionId: input.sessionId,
          clientMessageId: input.clientMessageId,
          error
        }
      )
      throw error instanceof AgentSessionOptionRejectedError ||
        error instanceof AgentSessionPreDispatchError ||
        error instanceof StructuredAgentSessionInputNotAdmitted ||
        isAbortSignalReason(input.signal, error)
        ? error
        : new AgentSessionOptionRejectedError(error)
    }
  })
  // Keep an explicit snapshot, even empty, to prevent fallback to configured choices.
  return outcome.state === 'accepted' || outcome.state === 'admitted'
    ? { ...outcome, ranOptions }
    : outcome
}
