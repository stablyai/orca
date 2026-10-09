import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../shared/agent-chat-permission-mode'
import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { ClaudeControlRequestError } from './claude-agent-sdk-control-requests'
import { serializeClaudePermissionApplication } from './claude-structured-permission-application'
import { claudePermissionModeWrite } from './claude-structured-permission-mode'
import { readClaudeCurrentModel } from './claude-structured-session-options'
import type { ClaudeSession } from './claude-structured-session-state'

export function setClaudePermissionModeOption(
  session: ClaudeSession,
  value: string,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
  narrowToAsk = false
): Promise<Readonly<Record<string, string>>> {
  const written = serializeClaudePermissionApplication(session, async (apply) => {
    throwIfSignalAborted(signal)
    const permission = claudePermissionModeWrite(session, value)
    if (!permission) {
      throw new AgentSessionOptionRejectedError(`claude has no permission mode named ${value}`)
    }
    const held = session.options.get(AGENT_CHAT_PERMISSION_MODE_OPTION_ID)
    const modelWasConfirmed = readClaudeCurrentModel(session).confirmed
    const mutation = ++session.optionMutationSequence
    if (modelWasConfirmed) {
      session.reportedModelMutation = mutation
    }
    // Unsupported Auto must stay narrowed even if the control answer is lost.
    if (narrowToAsk) {
      session.options.set(AGENT_CHAT_PERMISSION_MODE_OPTION_ID, 'ask')
      session.confirmedOptions.delete(AGENT_CHAT_PERMISSION_MODE_OPTION_ID)
    }
    if (permission.kind === 'live') {
      try {
        await apply(permission.mode, timeoutMs)
      } catch (error) {
        if (narrowToAsk) {
          console.warn('[native-chat] Claude permission narrowing needs reconciliation', error)
          return Object.fromEntries(session.options)
        }
        if (error instanceof ClaudeControlRequestError) {
          throw new AgentSessionOptionRejectedError(error)
        }
        throw error
      }
      if (value !== held) {
        session.translator?.modelMayHaveChanged()
      }
    }
    throwIfSignalAborted(signal)
    session.options.set(AGENT_CHAT_PERMISSION_MODE_OPTION_ID, value)
    session.confirmedOptions.delete(AGENT_CHAT_PERMISSION_MODE_OPTION_ID)
    return Object.fromEntries(session.options)
  })
  return waitForPromiseWithSignal(written, signal)
}
