// Each retry attempt gets a journal row; the transcript displays only the latest in a run.

import {
  agentSessionFailureFact,
  providerDiagnostic,
  readProviderRetry
} from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type { AgentJournalStatusItem } from '../../shared/agent-session-journal-types'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/tui-agent-display-names'
import {
  boundPayload,
  PROVIDER_FRAME_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'
import {
  readCodexErrorAdditionalDetails,
  readCodexErrorInfo,
  readCodexErrorMessage,
  readCodexErrorWillRetry
} from './codex-structured-thread-facts'

/** Retryable stream errors do not end the turn. */
export function isCodexProviderRetryFrame(event: CodexStructuredSessionEvent): boolean {
  return (
    event.type === 'notification' &&
    event.method === 'error' &&
    readCodexErrorWillRetry(event.params)
  )
}

export function codexProviderRetryRowBody(payload: unknown): AgentJournalStatusItem {
  const message = readCodexErrorMessage(payload)
  const detail = message ? providerDiagnostic(message, 'person') : undefined
  const additionalDetails = readCodexErrorAdditionalDetails(payload)
  const retry = readProviderRetry({
    ...readCodexErrorInfo(payload),
    // Do not repeat the message as its own cause.
    ...(additionalDetails && additionalDetails.trim() !== message?.trim()
      ? { cause: additionalDetails }
      : {})
  })
  const words = agentSessionFailureWords(
    agentSessionFailureFact('providerRetrying', {
      ...(detail ? { detail } : {}),
      ...(retry ? { retry } : {})
    }),
    { surface: 'row', agentName: TUI_AGENT_DISPLAY_NAMES.codex }
  )
  return {
    kind: 'status',
    tone: 'warning',
    ...words,
    providerFrame: {
      provider: 'codex',
      kind: 'notification:error',
      payload: boundPayload(JSON.stringify(payload), PROVIDER_FRAME_PAYLOAD_LIMITS)
    }
  }
}
