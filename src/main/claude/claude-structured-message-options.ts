import { StructuredAgentSessionInputNotAdmitted } from '../native-chat/agent-session-wire/structured-agent-session-input-admission'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { retireWaiter } from './claude-structured-dispatch-waiters'
import { claudeStartedUnechoedSend } from './claude-command-lifecycle'
import { claudeExecutionObservations } from './claude-structured-execution-observations'
import { dispatchClaudeTurn } from './claude-structured-dispatch'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import {
  createStructuredAgentSessionLogger,
  neverThrowingStructuredAgentSessionLogger
} from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { claudeTakesFlagSettings, setClaudeStructuredOption } from './claude-structured-options'
import {
  isAbortSignalReason,
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../shared/abort-signal-reason'
import type { waitForReplay } from './claude-structured-dispatch-waiters'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AgentSessionExecutionOptions } from '../../shared/agent-session-execution-options'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { ClaudeSession } from './structured/claude-structured-session-state'

const defaultLogger = createStructuredAgentSessionLogger()

export async function applyClaudeMessageOptions(
  session: ClaudeSession,
  options: AgentSessionExecutionOptions,
  timeoutMs: number | undefined,
  signal?: AbortSignal
): Promise<void> {
  throwIfSignalAborted(signal)
  const model = options.model
  if (model && session.appliedInputOptions.get('model') !== model) {
    await waitForPromiseWithSignal(
      setClaudeStructuredOption(session, { key: 'model', value: model }, timeoutMs),
      signal
    )
  }

  throwIfSignalAborted(signal)
  // Saved choices stay saved for a CLI that can apply them; this one runs on its own.
  const takesFlagSettings =
    (options.effort !== undefined || options.fastMode !== undefined) &&
    (await claudeTakesFlagSettings(session))
  throwIfSignalAborted(signal)
  const effort = takesFlagSettings ? options.effort : undefined
  if (effort && session.appliedInputOptions.get('effort') !== effort) {
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
}

export async function dispatchClaudeMessage(
  session: ClaudeSession,
  input: Parameters<StructuredAgentSessionAdapter['dispatch']>[0],
  timeoutMs: number | undefined,
  logger: StructuredAgentSessionLogger = defaultLogger
): ReturnType<StructuredAgentSessionAdapter['dispatch']> {
  let ranOptions: Record<string, string> = {}
  const outcome = await dispatchClaudeTurn(session, input, async () => {
    await input.beforeDispatch?.()
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

export async function continueClaudeAfterTransientFailure(
  session: ClaudeSession,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['continueAfterTransientFailure']>>[0],
  timeoutMs = 5_000
): ReturnType<NonNullable<StructuredAgentSessionAdapter['continueAfterTransientFailure']>> {
  if (session.fence !== input.fence || input.signal.aborted || session.translator?.currentTurnId) {
    return { state: 'refused' }
  }
  let replay: ReturnType<typeof waitForReplay> | undefined
  try {
    const outcome = await waitForPromiseWithSignal(
      dispatchClaudeTurn(
        session,
        {
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'Please continue.' }]
          },
          signal: input.signal,
          admitWrite: async (write) => {
            const admission = await input.admitFreshInput(
              () => ({ kind: 'sent', response: write() }),
              input.signal
            )
            if (admission.kind !== 'sent') {
              throw new StructuredAgentSessionInputNotAdmitted()
            }
            await admission.response
          },
          onReplay: (value) => {
            replay = value
          }
        },
        async () => {
          input.signal.throwIfAborted()
          if (input.options) {
            await applyClaudeMessageOptions(session, input.options, timeoutMs, input.signal)
          }
          input.signal.throwIfAborted()
        }
      ),
      input.signal
    )
    if (outcome.state === 'rejected') {
      return { state: 'refused' }
    }
    const uuid = replay
      ? await waitForPromiseWithSignal(withTimeout(replay.promise, timeoutMs, null), input.signal)
      : null
    const written = await waitForPromiseWithSignal(
      session.events?.written?.() ?? Promise.resolve({ ok: true }),
      input.signal
    )
    return uuid && written.ok ? { state: 'started', providerTurnRef: uuid } : { state: 'unknown' }
  } catch (error) {
    return {
      state: error instanceof StructuredAgentSessionInputNotAdmitted ? 'refused' : 'unknown'
    }
  } finally {
    if (replay && !replay.waiter.settledUuid) {
      retireWaiter(session, replay.waiter)
      replay.waiter.resolve(null)
    }
  }
}
