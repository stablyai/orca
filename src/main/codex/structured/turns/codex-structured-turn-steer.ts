import {
  StructuredAgentSessionInputNotAdmitted,
  type StructuredAgentSessionAdmitFreshInput
} from '../../../native-chat/agent-session-wire/structured-agent-session-input-admission'
import type { CodexTurnHost } from './codex-structured-turn-start'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { checkDispatchAuthority } from './codex-structured-dispatch-authority'
import { turnInputFor } from './codex-structured-message-options'
import { readCodexTurnId } from '../../app-server/codex-structured-thread-facts'
import { isCodexAppServerRequestError } from '../../app-server/codex-app-server-request-error'
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
): Promise<{ turnId: string; via: 'steer' } | null> {
  try {
    checkDispatchAuthority(host, input.clientMessageId, input.signal, input.isCurrent)
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
    if (isCodexAppServerRequestError(error) || isCodexAppServerUnsupportedError(error)) {
      return null
    }
    throw error
  }
}
