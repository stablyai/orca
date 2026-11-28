import {
  StructuredAgentSessionInputNotAdmitted,
  type StructuredAgentSessionAdmitFreshInput
} from '../../../native-chat/agent-session-wire/delivery/structured-agent-session-input-admission'
import type { CodexTurnHost } from './codex-structured-turn-contract'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { waitForPromiseWithSignal } from '../../../../shared/concurrency/abort-signal-reason'
import { checkDispatchAuthority } from './codex-structured-dispatch-authority'
import { turnInputFor } from './codex-structured-message-options'
import { CODEX_TURN_OPEN_WAIT_MS } from './codex-structured-turn-open-wait'
import { readCodexTurnId } from '../../app-server/codex-structured-thread-facts'
import { readRecord } from '../../app-server/codex-item-field-readers'
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
    if (isCodexAppServerRequestError(error)) {
      const info = readRecord(readRecord(error.data).codexErrorInfo)
      if (
        readRecord(info.activeTurnNotSteerable).turnKind === 'compact' &&
        host.activeTurnIds?.has(expectedTurnId)
      ) {
        // turn/start rejects input too while this compaction still owns the thread.
        const deadline = Date.now() + (input.timeoutMs ?? CODEX_TURN_OPEN_WAIT_MS)
        while (host.activeTurnIds?.has(expectedTurnId)) {
          const remaining = deadline - Date.now()
          if (remaining <= 0) {
            throw error
          }
          try {
            await waitForPromiseWithSignal(
              host.turnOpenWaits.wait(expectedTurnId, remaining),
              input.signal
            )
          } finally {
            checkDispatchAuthority(host, input.clientMessageId, input.signal, input.isCurrent)
          }
        }
      }
      return null
    }
    if (isCodexAppServerUnsupportedError(error)) {
      return null
    }
    throw error
  }
}
