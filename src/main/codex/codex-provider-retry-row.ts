// The row a Codex stream error it is about to retry writes: Codex's own progress sentence, what
// failed on the line under it, and a `providerRetrying` fact. Every attempt is its own row; the
// transcript draws only the latest of a run.

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
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'
import {
  readCodexErrorAdditionalDetails,
  readCodexErrorInfo,
  readCodexErrorMessage,
  readCodexErrorWillRetry
} from './codex-structured-thread-facts'

/** An `error` frame for a stream error Codex is about to retry; it ends nothing. */
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
    // Details that only repeat the message would print the same words twice.
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
      payload: boundPayload(JSON.stringify(payload), DEFAULT_JOURNAL_PAYLOAD_LIMITS)
    }
  }
}
