import {
  StructuredAgentSessionInputNotAdmitted,
  type StructuredAgentSessionAdmitFreshInput
} from '../../../native-chat/agent-session-wire/delivery/structured-agent-session-input-admission'
import type { CodexTurnHost } from './codex-structured-turn-contract'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { checkDispatchAuthority } from './codex-structured-dispatch-authority'
import { turnInputFor } from './codex-structured-message-options'
import { readCodexTurnId } from '../../app-server/codex-structured-thread-facts'
import {
  CodexAppServerRequestError,
  isCodexAppServerRequestError
} from '../../app-server/codex-app-server-request-error'
import { isCodexAppServerUnsupportedError } from '../../app-server/codex-app-server-session'

/** Explicit steering avoids pre-0.148 turn/start replies naming nonexistent turns; overrides wait for a start. */
export async function steerCodexTurn(
  host: CodexTurnHost,
  expectedTurnId: string,
  input: {
    clientMessageId: string
    body: AgentJournalMessageItem
    timeoutMs?: number
    signal?: AbortSignal
    isCurrent?: () => boolean
    onReply?: () => void
    admitFreshInput?: StructuredAgentSessionAdmitFreshInput
  }
): Promise<{ turnId: string; via: 'steer' } | { refused: CodexAppServerRequestError }> {
  try {
    checkDispatchAuthority(host, input.clientMessageId, input.signal, input.isCurrent)
    if (host.steeringSupported === false) {
      throw unsupportedSteer()
    }
    const enqueue = (mode: Parameters<Parameters<StructuredAgentSessionAdmitFreshInput>[0]>[0]) => {
      const state = host.permissions
      if (state && mode !== (state.appliedMode ?? state.acquiredMode)) {
        return { kind: 'acquire' as const, reason: 'permission' as const }
      }
      checkDispatchAuthority(host, input.clientMessageId, input.signal, input.isCurrent)
      host.dispatchEchoes.expect(
        input.clientMessageId,
        host.threadId,
        'steer',
        turnInputFor(host, input.body),
        expectedTurnId
      )
      return {
        kind: 'sent' as const,
        response: host.connection.request(
          'turn/steer',
          {
            threadId: host.threadId,
            expectedTurnId,
            clientUserMessageId: input.clientMessageId,
            input: turnInputFor(host, input.body)
          },
          { timeoutMs: input.timeoutMs, onReply: input.onReply }
        )
      }
    }
    const admission = input.admitFreshInput
      ? await input.admitFreshInput(enqueue, input.signal, 'steer')
      : enqueue(host.permissions?.appliedMode ?? host.permissions?.acquiredMode ?? 'ask')
    if (admission.kind !== 'sent') {
      host.dispatchEchoes.disarm(input.clientMessageId)
      throw new StructuredAgentSessionInputNotAdmitted(
        undefined,
        admission.kind === 'acquire' ? admission.reason : 'permission'
      )
    }
    const answer = await admission.response
    return { turnId: readCodexTurnId(answer) ?? expectedTurnId, via: 'steer' }
  } catch (error) {
    if (isCodexAppServerUnsupportedError(error)) {
      host.steeringSupported = false
      checkDispatchAuthority(host, input.clientMessageId, input.signal, input.isCurrent)
      throw unsupportedSteer()
    }
    if (isCodexAppServerRequestError(error)) {
      return { refused: error }
    }
    throw error
  }
}

function unsupportedSteer(): CodexAppServerRequestError {
  const message =
    'This Codex version cannot steer. Send again after the current turn, or update Codex.'
  return new CodexAppServerRequestError('turn/steer', -32601, message, message)
}
