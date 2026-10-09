// Codex error notifications keep diagnostics in Details and state whether another attempt follows.

import {
  agentSessionFailureFact,
  providerDiagnostic,
  readProviderRetry
} from '../../shared/agent-session-failure'
import { codexAuthenticationFailure } from './codex-authentication-failure'
import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type { AgentJournalStatusItem } from '../../shared/agent-session-journal-types'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/tui-agent-display-names'
import {
  boundPayload,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'
import {
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
  return codexProviderErrorRowBody(payload, 'providerRetrying')
}

export function codexProviderFinalErrorRowBody(
  payload: unknown,
  account?: AgentSessionAccountKind
): AgentJournalStatusItem {
  return codexProviderErrorRowBody(payload, 'providerError', account)
}

function codexProviderErrorRowBody(
  payload: unknown,
  kind: 'providerRetrying' | 'providerError',
  account?: AgentSessionAccountKind
): AgentJournalStatusItem {
  const message = readCodexErrorMessage(payload)
  const info = readCodexErrorInfo(payload)
  // A final capacity refusal explains how to continue; transport and retry details stay in Details.
  const audience = kind === 'providerError' && info?.error === 'serverOverloaded' ? 'person' : 'log'
  const detail = message ? providerDiagnostic(message, audience) : undefined
  const retry = kind === 'providerRetrying' ? readProviderRetry(info) : undefined
  const words = agentSessionFailureWords(
    (kind === 'providerError' ? codexAuthenticationFailure(payload, account) : null) ??
      agentSessionFailureFact(kind, {
        ...(detail ? { detail } : {}),
        ...(retry ? { retry } : {})
      }),
    { surface: 'row', agentName: TUI_AGENT_DISPLAY_NAMES.codex }
  )
  return {
    kind: 'status',
    tone: kind === 'providerRetrying' ? 'warning' : 'error',
    ...words,
    providerFrame: {
      provider: 'codex',
      kind: 'notification:error',
      payload: boundPayload(JSON.stringify(payload), DEFAULT_JOURNAL_PAYLOAD_LIMITS)
    }
  }
}
