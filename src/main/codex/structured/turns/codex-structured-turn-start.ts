import type { CodexTurnHost, CodexTurnInput } from './codex-structured-turn-contract'
import { captureCodexMessageCompilerInputs } from '../catalog/codex-structured-service-tier'
import {
  codexMessageInputOptions,
  compileCodexMessageOptions
} from '../../../../shared/agent-session/options/codex-message-compiler'
import { steerCodexTurn } from './codex-structured-turn-steer'
import { checkDispatchAuthority } from './codex-structured-dispatch-authority'
import { StructuredAgentSessionInputNotAdmitted } from '../../../native-chat/agent-session-wire/delivery/structured-agent-session-input-admission'
import { turnInputFor } from './codex-structured-message-options'
import { reportedCodexPermissionMode } from '../threads/codex-structured-thread-open'
import { admitCodexTurnPermission } from './codex-structured-turn-permission'
import {
  agentSessionFailureFact,
  providerDiagnosticOf
} from '../../../../shared/agent-session/failures/agent-session-failure'
import type { AgentJournalTurnJoin } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionDispatchOutcome } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { isCodexAppServerRequestError } from '../../app-server/codex-app-server-request-error'
import { isCodexAppServerUnsupportedError } from '../../app-server/codex-app-server-session'
import { readCodexTurnId } from '../../app-server/codex-structured-thread-facts'
import { codexRunningOrOpeningTurn, codexStopTarget } from './codex-structured-turn-open-wait'
import { codexDispatchRejection } from './codex-structured-turn-end-settlement'

/** false means correlation capacity refused the send before writing; null turnId means an unnamed answer. */
export async function startCodexTurn(
  host: CodexTurnHost,
  input: CodexTurnInput & {
    timeoutMs?: number
    onReply?: () => void
  }
): Promise<{ turnId: string | null; via: AgentJournalTurnJoin } | false> {
  // Arm before writing: echoes and turn/started can arrive before the reply.
  if (!host.dispatchEchoes.arm(input.clientMessageId, input.requestedAt)) {
    return false
  }
  // Interrupt-acknowledged turns cannot take steers while awaiting completion.
  const steerable = (turnId: string | null | undefined): turnId is string =>
    typeof turnId === 'string' && turnId !== '' && !host.abortedTurnIds?.has(turnId)
  let runningTurnId: string | null
  try {
    runningTurnId = await codexRunningOrOpeningTurn(host, input.signal)
  } catch (error) {
    host.dispatchEchoes.disarm(input.clientMessageId)
    checkDispatchAuthority(host, input.clientMessageId, input.signal, input.isCurrent)
    throw error
  }
  let steered = steerable(runningTurnId) ? await steerCodexTurn(host, runningTurnId, input) : null
  // Retry steering once if another turn opened during the refused request.
  const runningSince = steered ? undefined : [...(host.activeTurnIds ?? [])].at(-1)
  if (steerable(runningSince) && runningSince !== runningTurnId) {
    steered = await steerCodexTurn(host, runningSince, input)
  }
  if (steered) {
    return steered
  }
  let previousApplied = host.appliedTurnOptions
  let previousInput = host.appliedTurnInputOptions
  let previousOptions: Map<string, string> | null | undefined
  let requested: Readonly<Record<string, string>> = {}
  let inputChoices: Readonly<Record<string, string | undefined>> = {}
  let requestControls: Record<string, string> = {}
  let enqueued = false
  let discardSettingsAttempt: (() => void) | undefined
  const enqueue = (
    permission: Parameters<Parameters<typeof admitCodexTurnPermission>[2]>[0],
    body = input.body,
    mode = host.permissions?.acquiredMode
  ) => {
    checkDispatchAuthority(host, input.clientMessageId, input.signal, input.isCurrent)
    // turn/start can steer too; a refused steer must not bypass the final policy boundary.
    if (
      host.permissions &&
      mode &&
      mode !== (host.permissions.appliedMode ?? host.permissions.acquiredMode) &&
      codexStopTarget(host) !== null
    ) {
      throw new StructuredAgentSessionInputNotAdmitted(undefined, 'permission')
    }
    previousApplied = host.appliedTurnOptions
    previousInput = host.appliedTurnInputOptions
    inputChoices = input.executionOptions ?? input.turnOptions ?? Object.fromEntries(host.options)
    previousOptions = input.turnOptions ? new Map(host.options) : null
    if (input.turnOptions) {
      host.options.clear()
      for (const [key, value] of Object.entries(
        codexMessageInputOptions(inputChoices, {}, input.turnOptions)
      )) {
        host.options.set(key, value)
      }
    }
    requested = {
      interactionMode: 'default',
      ...compileCodexMessageOptions(
        captureCodexMessageCompilerInputs(host),
        input.turnOptions ?? Object.fromEntries(host.options)
      )
    }
    const { interactionMode, ...nativeOptions } = requested
    const collaborationMode = {
      mode: interactionMode,
      settings: {
        model: nativeOptions.model ?? previousApplied?.model ?? host.reportedOptions?.model,
        reasoning_effort:
          nativeOptions.effort ?? previousApplied?.effort ?? host.reportedOptions?.effort ?? null,
        developer_instructions: null
      }
    }
    requestControls = {
      ...requested,
      ...(collaborationMode.settings.model ? { model: collaborationMode.settings.model } : {}),
      ...(collaborationMode.settings.reasoning_effort
        ? { effort: collaborationMode.settings.reasoning_effort }
        : {})
    }
    const known = { ...previousApplied }
    const knownInput = { ...previousInput }
    for (const key of new Set([...Object.keys(requested), ...Object.keys(inputChoices)])) {
      delete known[key]
      delete knownInput[key]
    }
    host.appliedTurnOptions = known
    host.appliedTurnInputOptions = knownInput
    discardSettingsAttempt = host.appliedSettings?.attempt(requested)
    enqueued = true
    host.dispatchEchoes.expect(
      input.clientMessageId,
      host.threadId,
      'start',
      turnInputFor(host, body)
    )
    const previousMode = host.permissions?.appliedMode
    if (host.permissions && mode) {
      host.permissions.appliedMode = mode
    }
    return {
      kind: 'sent' as const,
      response: host.connection
        .request(
          'turn/start',
          {
            threadId: host.threadId,
            clientUserMessageId: input.clientMessageId,
            input: turnInputFor(host, body),
            ...permission,
            ...nativeOptions,
            collaborationMode
          },
          {
            timeoutMs: input.timeoutMs,
            onReply: (reply) => {
              // Record before the rest of the reply's stdout chunk is translated.
              const turnId = readCodexTurnId(reply)
              if (turnId) {
                host.dispatchEchoes.repliedTurn(input.clientMessageId, host.threadId, turnId)
              }
              input.onReply?.()
            }
          }
        )
        .catch((error: unknown) => {
          if (
            host.permissions &&
            (isCodexAppServerRequestError(error) || isCodexAppServerUnsupportedError(error))
          ) {
            host.permissions.appliedMode = previousMode
          }
          throw error
        })
        .then((answer) => {
          const applied = reportedCodexPermissionMode({
            ...permission,
            sandbox: permission.sandboxPolicy
          })
          // Successful fresh-turn policy is applied evidence, not a provider readback.
          if (applied && host.reportedOptions) {
            host.reportedOptions.reportedPermissionMode = applied
          }
          return answer
        })
    }
  }
  let answer: unknown
  try {
    answer = await admitCodexTurnPermission(host, input.admitFreshInput, enqueue, input.signal)
  } catch (error) {
    if (!enqueued) {
      host.dispatchEchoes.disarm(input.clientMessageId)
      checkDispatchAuthority(host, input.clientMessageId, input.signal, input.isCurrent)
    }
    if (isCodexAppServerRequestError(error) || isCodexAppServerUnsupportedError(error)) {
      discardSettingsAttempt?.()
      host.appliedTurnOptions = previousApplied
      host.appliedTurnInputOptions = previousInput
      if (previousOptions) {
        host.options.clear()
        for (const [key, value] of previousOptions) {
          host.options.set(key, value)
        }
      }
    }
    throw error
  }
  host.appliedTurnOptions = { ...previousApplied, ...requested }
  host.appliedTurnInputOptions = codexMessageInputOptions(
    inputChoices,
    {
      serviceTier: 'default',
      ...requestControls,
      ...previousInput,
      interactionMode: requestControls.interactionMode
    },
    requested
  )
  return { turnId: readCodexTurnId(answer), via: 'start' }
}

/** Replies establish admission; exact echoes establish identity. Timeouts cannot disprove delivery. */
export async function dispatchCodexTurn(
  session: CodexTurnHost,
  input: CodexTurnInput & { sessionId: string },
  timeoutMs: number | undefined
): Promise<AgentSessionDispatchOutcome> {
  let answer: { turnId: string | null; via: AgentJournalTurnJoin } | false
  // Capture wire order at reply receipt, before async continuations run.
  let answeredAt: number | undefined
  const onReply = (): void => {
    answeredAt = session.dispatchEchoes.tick()
  }
  try {
    answer = await startCodexTurn(session, { ...input, timeoutMs, onReply })
  } catch (error) {
    if (error instanceof StructuredAgentSessionInputNotAdmitted) {
      throw error
    }
    if (isCodexAppServerRequestError(error) || isCodexAppServerUnsupportedError(error)) {
      // Codex answered and declined, so no echo for this write can arrive.
      session.dispatchEchoes.disarm(input.clientMessageId)
      // Declined requests recorded no input; carried stopped messages remain owed.
      return {
        state: 'rejected',
        ...codexDispatchRejection(
          agentSessionFailureFact('providerRejected', {
            detail: providerDiagnosticOf(error),
            neverReachedAgent: true
          })
        )
      }
    }
    // Transport failure may follow a successful write; keep correlation for a later echo.
    session.dispatchEchoes.answered(
      input.clientMessageId,
      answeredAt ?? session.dispatchEchoes.tick()
    )
    throw error
  }
  if (!answer) {
    return { state: 'rejected', ...codexDispatchRejection(agentSessionFailureFact('queueFull')) }
  }
  // An answer read after the turn it names already ended is settled by that end.
  if (answer.turnId) {
    session.dispatchEchoes.bindTurn(
      input.clientMessageId,
      session.threadId,
      answer.turnId,
      answer.via,
      answeredAt
    )
  } else {
    session.dispatchEchoes.answered(
      input.clientMessageId,
      answeredAt ?? session.dispatchEchoes.tick()
    )
  }
  return { state: 'admitted', ranOptions: { ...session.appliedTurnOptions } }
}
