import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { CodexSession } from '../session-lifecycle/codex-structured-session-state'
import { resolvedCodexGoalSettings } from './codex-structured-message-options'
import { codexMethodUnavailable } from '../catalog/codex-structured-applied-settings'
import { readCodexTurnId } from '../../app-server/codex-structured-thread-facts'
import { isCodexAppServerRequestError } from '../../app-server/codex-app-server-request-error'
import {
  agentSessionFailureFact,
  providerDiagnostic
} from '../../../../shared/agent-session/failures/agent-session-failure'
import * as turnEnd from './codex-structured-turn-end-settlement'

export async function reviewCodexStructuredSession(
  session: CodexSession,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['review']>>[0],
  timeoutMs: number | undefined
): ReturnType<NonNullable<StructuredAgentSessionAdapter['review']>> {
  const choices = resolvedCodexGoalSettings(session, input.executionOptions)
  const current: Readonly<Record<string, string | undefined>> = {
    model: session.appliedTurnOptions?.model,
    effort: session.appliedTurnOptions?.effort
  }
  if (
    session.appliedSettings?.hasPendingUpdates() ||
    Object.entries(choices).some(([key, value]) => value !== current[key])
  ) {
    const previousApplied = session.appliedTurnOptions
    const previousInput = session.appliedTurnInputOptions
    const known = { ...previousApplied }
    const knownInput = { ...previousInput }
    for (const key of Object.keys(choices)) {
      delete known[key]
      delete knownInput[key]
    }
    session.appliedTurnOptions = known
    session.appliedTurnInputOptions = knownInput
    const attempt = session.appliedSettings?.attempt(choices)
    try {
      await session.connection.request(
        'thread/settings/update',
        { threadId: session.threadId, ...choices },
        { timeoutMs }
      )
      attempt?.acknowledge()
      session.appliedTurnOptions = { ...session.appliedTurnOptions, ...choices }
      session.appliedTurnInputOptions = { ...session.appliedTurnInputOptions, ...choices }
    } catch (error) {
      if (
        isCodexAppServerRequestError(error) ||
        codexMethodUnavailable(error, 'thread/settings/update')
      ) {
        attempt?.discard()
        session.appliedTurnOptions = previousApplied
        session.appliedTurnInputOptions = previousInput
      }
      if (codexMethodUnavailable(error, 'thread/settings/update')) {
        session.translator?.forgetCommand(input.command.turnId)
        return {
          state: 'rejected',
          ...turnEnd.codexDispatchRejection(
            agentSessionFailureFact('reviewSettingsUnsupported', {
              detail: current.model ? providerDiagnostic(current.model, 'person') : undefined
            })
          )
        }
      }
      return {
        state: 'rejected',
        ...turnEnd.codexDispatchRejection(agentSessionFailureFact('reviewFailed'))
      }
    }
  }
  if (session.ended || session.fence !== input.fence) {
    return {
      state: 'rejected',
      ...turnEnd.codexDispatchRejection(agentSessionFailureFact('reviewFailed'))
    }
  }
  session.translator?.beginCommand(input.command)
  try {
    const target = input.command.review ?? { type: 'custom' }
    await session.connection.request(
      'review/start',
      {
        threadId: session.threadId,
        target:
          target.type === 'custom'
            ? { ...target, instructions: input.command.instructions }
            : target,
        delivery: 'inline'
      },
      {
        timeoutMs,
        onReply: (reply) => {
          const turnId = readCodexTurnId(reply)
          if (turnId) {
            session.translator?.claimCommandTurn(turnId)
          }
        }
      }
    )
    return { state: 'accepted', providerIdentity: null }
  } catch (error) {
    if (isCodexAppServerRequestError(error)) {
      session.translator?.forgetCommand(input.command.turnId)
      return {
        state: 'rejected',
        ...turnEnd.codexDispatchRejection(agentSessionFailureFact('reviewFailed'))
      }
    }
    throw error
  }
}

export async function cleanCodexBackgroundTerminals(
  session: CodexSession | undefined,
  timeoutMs: number | undefined
): Promise<void> {
  if (!session || session.ended) {
    return
  }
  try {
    await session.connection.request(
      'thread/backgroundTerminals/clean',
      { threadId: session.threadId },
      { timeoutMs }
    )
  } catch (error) {
    throw new Error(
      codexMethodUnavailable(error, 'thread/backgroundTerminals/clean')
        ? "This Codex version can't stop background terminals from chat. Update Codex."
        : isCodexAppServerRequestError(error)
          ? "Codex couldn't stop its background terminals. Try /stop again."
          : "Codex couldn't confirm its background terminals stopped. Check them before trying /stop again."
    )
  }
}
