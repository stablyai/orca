import { setTimeout as delay } from 'node:timers/promises'
import { claudeBuildPermissionMode } from '../permissions/claude-plan-approval-mode'
import {
  claudeBypassRefused,
  claudeOwesFullAccessFallback,
  setClaudeAllowedPermissionMode
} from '../permissions/claude-full-access-refusal'
import { claudeStartedUnechoedSend } from '../turns/claude-command-lifecycle'
import { claudeExecutionObservations } from '../turns/claude-structured-execution-observations'
import { dispatchClaudeTurn } from '../dispatch/claude-structured-dispatch'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { AgentSessionExecutionOptions } from '../../../../shared/agent-session/options/protocol/agent-session-execution-options'
import { AgentSessionOptionRejectedError } from '../../../native-chat/agent-session-wire/options/structured-agent-session-option-error'
import { StructuredAgentSessionInputNotAdmitted } from '../../../native-chat/agent-session-wire/delivery/structured-agent-session-input-admission'
import { AgentSessionPreDispatchError } from '../../../native-chat/agent-session-wire/operations/structured-agent-session-operation-settlement'
import {
  createStructuredAgentSessionLogger,
  neverThrowingStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { claudeTakesFlagSettings, setClaudeStructuredOption } from './claude-structured-options'
import type { ClaudeSession } from '../claude-structured-session-state'
import {
  isAbortSignalReason,
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../../../shared/concurrency/abort-signal-reason'

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
  if (options.interactionMode !== undefined) {
    if (options.interactionMode === 'plan') {
      await waitForPromiseWithSignal(
        session.connection.setPermissionMode('plan', { timeoutMs }),
        signal
      )
      session.appliedInputOptions.set('interactionMode', 'plan')
    } else if (claudeBypassRefused(session)) {
      await applyClaudeFullAccessFallback(session, timeoutMs, signal, true)
      session.appliedInputOptions.set('interactionMode', options.interactionMode)
    } else {
      const mode = await waitForPromiseWithSignal(
        setClaudeAllowedPermissionMode(session, claudeBuildPermissionMode(session), {
          timeoutMs
        }),
        signal
      )
      session.appliedInputOptions.set('interactionMode', options.interactionMode)
      session.appliedInputOptions.set('buildPermissionMode', mode)
    }
  } else {
    await applyClaudeFullAccessFallback(session, timeoutMs, signal)
  }
  throwIfSignalAborted(signal)
}

const CLAUDE_STARTUP_SETTINGS_WAIT_MS = 5_000

/** Claude starts a refused Full access chat in its own fallback; the chat's is Approve for me. A
 *  first send waits briefly for the startup settings read that tells, and a failed switch leaves
 *  the send to run as Claude stands (the next send tries again). */
export async function applyClaudeFullAccessFallback(
  session: ClaudeSession,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  buildPicked = false
): Promise<void> {
  if (
    session.launchIntent?.permissionMode === 'bypassPermissions' &&
    session.bypassDisabled === undefined &&
    !session.firstRootInit &&
    session.startupSettings
  ) {
    await waitForPromiseWithSignal(
      Promise.race([
        session.startupSettings,
        delay(CLAUDE_STARTUP_SETTINGS_WAIT_MS, undefined, { ref: false, signal })
      ]),
      signal
    )
  }
  if (!buildPicked && !claudeOwesFullAccessFallback(session)) {
    return
  }
  const mode = await waitForPromiseWithSignal(
    setClaudeAllowedPermissionMode(session, claudeBuildPermissionMode(session), {
      timeoutMs
    }).catch(() => null),
    signal
  )
  if (mode !== null) {
    session.appliedInputOptions.set('buildPermissionMode', mode)
  }
}

// Bounded so an unanswered request still lets the steer through.
const CLAUDE_STEER_BACKGROUND_TIMEOUT_MS = 5_000

/** A steer interrupts the running step but waits on foreground work, so top-level subagents and commands move to the background; Ctrl+B would also move a subagent's own commands, which die when it ends. */
async function backgroundClaudeWorkForSteer(
  session: ClaudeSession,
  input: Parameters<StructuredAgentSessionAdapter['dispatch']>[0],
  logger: StructuredAgentSessionLogger
): Promise<void> {
  const moves = [...session.childWork.live.values()].flatMap((task) =>
    // A subagent's own tasks (parentTaskId) stay with it.
    !task.backgrounded && task.parentTaskId === undefined && task.toolUseId
      ? [
          session.connection.backgroundTask(task.toolUseId, {
            timeoutMs: CLAUDE_STEER_BACKGROUND_TIMEOUT_MS
          })
        ]
      : []
  )
  for (const move of await Promise.allSettled(moves)) {
    if (move.status === 'rejected') {
      neverThrowingStructuredAgentSessionLogger(logger).warn(
        'moving Claude foreground work to the background for a steer failed',
        {
          scope: 'claude-message-options',
          sessionId: input.sessionId,
          clientMessageId: input.clientMessageId,
          error: move.reason
        }
      )
    }
  }
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
      input.onInputPreparation?.()
      let steers =
        session.translator?.openTurnHasInputWork === true &&
        input.body.from?.orchestration?.message !== 'mail-notice'
      if (steers) {
        await waitForPromiseWithSignal(
          backgroundClaudeWorkForSteer(session, input, logger),
          input.signal
        )
        // The turn can end during the wait; then this is a plain send with its own choices.
        steers = session.translator?.openTurnHasInputWork === true
      }
      // Input joining a running turn, and Orca mail notices, run on the choices Claude already has;
      // new choices apply at the next new turn.
      const messageOptions =
        session.translator?.openTurnHasInputWork ||
        session.translator?.commandTurnId ||
        claudeStartedUnechoedSend(session) ||
        input.body.from?.orchestration?.message === 'mail-notice'
          ? undefined
          : input.executionOptions
      if (messageOptions !== undefined) {
        await applyClaudeMessageOptions(session, messageOptions, timeoutMs, input.signal)
      } else if (input.body.from?.orchestration?.message === 'mail-notice' && !steers) {
        // A mail notice that opens a turn keeps the chat's choices, but not Claude's refusal mode.
        await applyClaudeFullAccessFallback(session, timeoutMs, input.signal)
      }
      input.signal?.throwIfAborted()
      await input.beforeDispatch?.()
      input.onExecutionSnapshot?.()
      ranOptions = claudeExecutionObservations(session)
      if (messageOptions?.model && ranOptions.model !== messageOptions.model) {
        delete ranOptions.model
      }
      return { steers }
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
