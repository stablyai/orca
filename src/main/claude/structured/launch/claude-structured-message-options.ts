import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { claudeBuildPermissionMode } from '../permissions/claude-plan-approval-mode'
import {
  claudeAutoFallbackReason,
  claudeBypassRefused,
  claudeInPlan,
  claudeOwesPermissionFallback
} from '../permissions/claude-full-access-refusal'
import {
  claimClaudePermissionModeRequest,
  ClaudePermissionModeUnsettled,
  recordClaudeBuildPermissionMode,
  setClaudeAllowedPermissionMode
} from '../permissions/claude-permission-mode-ladder'
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
  // Claude owns the model after a refusal fallback until a pick, which is sent even if unchanged.
  const fallback = session.modelFallback
  if (
    model &&
    (fallback?.picked ||
      (session.appliedInputOptions.get('model') !== model && model !== fallback?.replaced))
  ) {
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
      const request = claimClaudePermissionModeRequest(session)
      await waitForPromiseWithSignal(
        session.connection.setPermissionMode('plan', { timeoutMs }),
        signal
      )
      if (session.permissionModeRequests === request) {
        session.appliedInputOptions.set('interactionMode', 'plan')
      }
    } else {
      await waitForClaudeStartupSettings(session, signal)
      const leavingPlan = claudeInPlan(session)
      const refused = claudeBypassRefused(session) || claudeAutoFallbackReason(session) !== null
      const write =
        !leavingPlan && refused && !claudeOwesPermissionFallback(session)
          ? null
          : writeClaudeBuildMode(session, timeoutMs, !leavingPlan && refused)
      const request = session.permissionModeRequests
      const mode = write && (await waitForPromiseWithSignal(write, signal))
      if (session.permissionModeRequests === request) {
        session.appliedInputOptions.set('interactionMode', options.interactionMode)
        if (mode) {
          recordClaudeBuildPermissionMode(session, mode)
        }
      }
    }
  } else {
    await applyClaudePermissionFallback(session, timeoutMs, signal)
  }
  throwIfSignalAborted(signal)
}

/** A failed switch leaves Claude's mode unknown, so the recorded fallback goes: the warning waits
 *  and the next input asks again. It fails the input only where the chat may still be in Plan,
 *  unless Claude accepted a step out of it, or where the chat picked the mode itself. */
function writeClaudeBuildMode(
  session: ClaudeSession,
  timeoutMs: number | undefined,
  tolerate: boolean
): Promise<PermissionMode | null | undefined> {
  const write = setClaudeAllowedPermissionMode(session, claudeBuildPermissionMode(session), {
    timeoutMs
  })
  const request = session.permissionModeRequests
  return write.catch((error: unknown) => {
    if (session.permissionModeRequests !== request) {
      return
    }
    if (!tolerate && !(error instanceof ClaudePermissionModeUnsettled)) {
      throw error
    }
    session.appliedInputOptions.delete('buildPermissionMode')
    return null
  })
}

async function waitForClaudeStartupSettings(
  session: ClaudeSession,
  signal: AbortSignal | undefined
): Promise<void> {
  const intent = session.launchIntent?.permissionMode
  const waitForSettings =
    (intent === 'bypassPermissions' &&
      session.bypassDisabled === undefined &&
      !session.firstRootInit) ||
    (intent === 'auto' &&
      session.autoDisabled === undefined &&
      session.firstRootInit?.permissionMode !== 'auto' &&
      !claudeInPlan(session))
  const pending = session.startupSettings
  if (!waitForSettings || !pending) {
    return
  }
  await waitForPromiseWithSignal(pending, signal)
}

async function applyClaudePermissionFallback(
  session: ClaudeSession,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined
): Promise<void> {
  await waitForClaudeStartupSettings(session, signal)
  if (!claudeOwesPermissionFallback(session)) {
    return
  }
  const write = writeClaudeBuildMode(session, timeoutMs, true)
  const request = session.permissionModeRequests
  const mode = await waitForPromiseWithSignal(write, signal)
  if (mode && session.permissionModeRequests === request) {
    recordClaudeBuildPermissionMode(session, mode)
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
      // Claude's refusal mode is no choice of the chat's, so any input moves it to the fallback.
      await (messageOptions !== undefined
        ? applyClaudeMessageOptions(session, messageOptions, timeoutMs, input.signal)
        : applyClaudePermissionFallback(session, timeoutMs, input.signal))
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
