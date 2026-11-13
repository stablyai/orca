import type { AgentJournalStatusItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentSessionFailureFact,
  providerDiagnostic,
  type AgentSessionFailureKind
} from '../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import { unhandledProviderFrameJournalItem } from '../native-chat/agent-session-wire/providers/unhandled-provider-frame'
import { hookOutcomeRowBody } from '../../shared/agent-session/journal/agent-session-hook-outcome'
import { traexRecord, traexText } from './traex-protocol'

export function traexFailureNotice(value: unknown): AgentJournalStatusItem {
  const params = traexRecord(value),
    error = traexRecord(params.error)
  const info = error.codexErrorInfo
  const code = typeof info === 'string' ? info : Object.keys(traexRecord(info))[0]
  const status = code ? traexRecord(traexRecord(info)[code]).httpStatusCode : undefined
  const text =
    traexText(error.additionalDetails) ?? traexText(error.message) ?? 'TRAE CLI request failed'
  let kind: AgentSessionFailureKind = 'providerResponseFailed'
  if (code === 'unauthorized' || status === 401) {
    kind = 'notSignedIn'
  } else if (code === 'modelNotFound') {
    kind = 'modelUnavailable'
  } else if (
    code === 'serverOverloaded' ||
    (typeof status === 'number' && [429, 500, 502, 503, 504].includes(status))
  ) {
    kind = 'providerUnavailable'
  } else if (code === 'cyberPolicy' || code === 'misalignmentPolicyViolation') {
    kind = 'providerSafetyStopped'
  } else if (
    [
      'contextWindowExceeded',
      'sessionBudgetExceeded',
      'usageLimitExceeded',
      'rateLimitExceeded'
    ].includes(code ?? '')
  ) {
    kind = 'usageLimitReached'
  }
  const diagnostic = providerDiagnostic(text, kind === 'notSignedIn' ? 'log' : 'person')
  const frame = unhandledProviderFrameJournalItem('trae', 'notification:error', params)
  return {
    ...frame?.body,
    kind: 'status',
    ...agentSessionFailureWords(
      agentSessionFailureFact(kind, diagnostic ? { detail: diagnostic } : {}),
      { agentName: 'TRAE CLI', surface: 'row' }
    )
  }
}

export function traexNotificationNotice(
  method: string,
  value: unknown
): AgentJournalStatusItem | null {
  const params = traexRecord(value)
  if (method === 'error') {
    return params.willRetry === true
      ? {
          kind: 'status',
          ...agentSessionFailureWords(agentSessionFailureFact('providerRetrying'), {
            agentName: 'TRAE CLI',
            surface: 'row'
          })
        }
      : traexFailureNotice(params)
  }
  if (['warning', 'guardianWarning', 'configWarning', 'deprecationNotice'].includes(method)) {
    const text = ['configWarning', 'deprecationNotice'].includes(method)
      ? [traexText(params.summary), traexText(params.details)].filter(Boolean).join('\n\n') ||
        traexText(params.message)
      : traexText(params.message)
    const frame = unhandledProviderFrameJournalItem('trae', `notification:${method}`, params)
    return text
      ? {
          ...frame?.body,
          kind: 'status',
          text,
          tone:
            method === 'guardianWarning' && text.startsWith('Automatic approval review approved (')
              ? 'notice'
              : 'warning'
        }
      : null
  }
  if (method === 'hook/completed') {
    const run = traexRecord(params.run)
    const details = Array.isArray(run.entries)
      ? run.entries.flatMap((entry) =>
          traexRecord(entry).kind === 'context' ? [] : (traexText(traexRecord(entry).text) ?? [])
        )
      : []
    if (run.status === 'blocked' || run.status === 'stopped') {
      return hookOutcomeRowBody(run.status, details)
    }
    if (run.status === 'failed') {
      return { kind: 'status', tone: 'warning', text: details.join('\n') || 'TRAE CLI hook failed' }
    }
  }
  return null
}
