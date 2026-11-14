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
  session.translator?.beginCommand(input.command)
  const choices = resolvedCodexGoalSettings(session, input.executionOptions)
  if (Object.entries(choices).some(([key, value]) => value !== session.appliedTurnOptions?.[key])) {
    try {
      await session.connection.request(
        'thread/settings/update',
        { threadId: session.threadId, ...choices },
        { timeoutMs }
      )
      session.appliedTurnOptions = { ...session.appliedTurnOptions, ...choices }
      session.appliedTurnInputOptions = { ...session.appliedTurnInputOptions, ...choices }
    } catch (error) {
      if (codexMethodUnavailable(error, 'thread/settings/update')) {
        session.translator?.forgetCommand(input.command.turnId)
        return {
          state: 'rejected',
          ...turnEnd.codexDispatchRejection(
            agentSessionFailureFact('reviewSettingsUnsupported', {
              detail: session.appliedTurnOptions?.model
                ? providerDiagnostic(session.appliedTurnOptions.model, 'person')
                : undefined
            })
          )
        }
      }
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
  if (session.ended || session.fence !== input.fence) {
    throw new Error('Codex session changed before review.')
  }
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
  session: CodexSession,
  timeoutMs: number | undefined
): Promise<void> {
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
