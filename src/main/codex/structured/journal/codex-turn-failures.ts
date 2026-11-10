import { createHash } from 'node:crypto'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import type { AgentSessionAccountKind } from '../../../../shared/agent-session/agent-session-availability'
import {
  readCodexErrorInfo,
  readCodexTurnId,
  readCodexTurnStatus
} from '../../app-server/codex-structured-thread-facts'
import { readRecord } from '../../app-server/codex-item-field-readers'
import { codexAuthenticationFailure } from '../session-lifecycle/codex-authentication-failure'
import { CodexUsageLimits } from '../catalog/codex-usage-limits'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import {
  unhandledProviderFrameJournalItem,
  type UnhandledProviderFrameJournalItem
} from '../../../native-chat/agent-session-wire/providers/unhandled-provider-frame'
import {
  CODEX_JOURNAL_ADMITTED,
  type CodexJournalTranslationAdmission
} from './codex-structured-journal-contracts'
import { MAX_CODEX_GENERIC_TURN_BUCKETS } from './codex-structured-journal-limits'
import type { AgentJournalStatusItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'

type ErrorInfo = { error: string; status?: number }
type TerminalSignature = { code?: string; message?: string; status?: number }
type FailureEvidence =
  | { phase: 'retry'; info: ErrorInfo; text: string }
  | { phase: 'terminal'; signature: TerminalSignature }

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function scopeKey(threadId: string, turnId: string | null): string | null {
  return turnId === null ? null : digest(JSON.stringify([threadId, turnId]))
}

function errorStatus(payload: unknown): number | undefined {
  const status = readCodexErrorInfo(payload)?.status
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined
}

function failureText(payload: unknown): string | undefined {
  const error = readRecord(readRecord(payload).error)
  return typeof error.additionalDetails === 'string'
    ? error.additionalDetails
    : typeof error.message === 'string'
      ? error.message
      : undefined
}

function terminalSignature(payload: unknown): TerminalSignature {
  const info = readCodexErrorInfo(payload)
  const message = readRecord(readRecord(payload).error).message
  const status = errorStatus(payload)
  return {
    ...(info ? { code: digest(info.error) } : {}),
    ...(typeof message === 'string' ? { message: digest(message) } : {}),
    ...(status !== undefined ? { status } : {})
  }
}

export class CodexTurnFailures {
  private readonly usageLimits = new CodexUsageLimits()
  private readonly evidence = new Map<string, FailureEvidence>()

  constructor(
    private readonly deps: {
      account?: () => AgentSessionAccountKind | undefined
      activeTurn: (threadId: string) => string | null
      append: (
        threadId: string,
        payload: unknown,
        frame: Omit<UnhandledProviderFrameJournalItem, 'body'> & { body: AgentJournalStatusItem }
      ) => CodexJournalTranslationAdmission
    }
  ) {}

  appendTerminal(
    kind: string,
    payload: unknown,
    errorPayload: unknown,
    threadId: string
  ): CodexJournalTranslationAdmission {
    const translated = unhandledProviderFrameJournalItem('codex', kind, payload, undefined, {
      reportsFailure: true
    })
    if (!translated) {
      return CODEX_JOURNAL_ADMITTED
    }
    const failure = this.failure(errorPayload, threadId, this.deps.account?.())
    const admission = this.deps.append(threadId, payload, {
      ...translated,
      body: {
        ...translated.body,
        ...(failure.kind === 'usageLimitReached' ? { tone: 'warning' } : {}),
        ...agentSessionFailureWords(failure, {
          provider: 'codex',
          agentName: 'Codex',
          surface: 'row'
        })
      }
    })
    if (admission.accepted) {
      this.admittedTerminal(
        errorPayload,
        threadId,
        readCodexTurnId(payload) ?? this.deps.activeTurn(threadId)
      )
    }
    return admission
  }

  appendCompletion(
    payload: unknown,
    threadId: string,
    onShown: (turnId: string) => void
  ): CodexJournalTranslationAdmission {
    const turn = readRecord(readRecord(payload).turn)
    const status = readCodexTurnStatus(payload)
    const turnId = readCodexTurnId(payload) ?? this.deps.activeTurn(threadId)
    if (!turnId || (status !== 'failed' && !(status === 'interrupted' && turn.error))) {
      return CODEX_JOURNAL_ADMITTED
    }
    const errorPayload = { turnId, error: turn.error, willRetry: false }
    const admission = this.repeatsTerminal(errorPayload, threadId, turnId)
      ? CODEX_JOURNAL_ADMITTED
      : this.appendTerminal('notification:turn/completed', payload, errorPayload, threadId)
    if (admission.accepted) {
      onShown(turnId)
    }
    return admission
  }

  observe(kind: string, payload: unknown): boolean {
    return this.usageLimits.observe(kind, payload)
  }

  observeRetry(payload: unknown, threadId: string): void {
    const info = readCodexErrorInfo(payload)
    const text = failureText(payload)
    const key = scopeKey(threadId, readCodexTurnId(payload))
    if (!key || !info || info.error === 'other' || text === undefined) {
      return
    }
    this.remember(key, {
      phase: 'retry',
      info: {
        error: info.error.length <= 128 ? info.error : 'other',
        status: errorStatus(payload)
      },
      text: digest(text)
    })
  }

  private failure(payload: unknown, threadId: string, account?: AgentSessionAccountKind) {
    let info = readCodexErrorInfo(payload)
    const key = scopeKey(threadId, readCodexTurnId(payload))
    const previous = key ? this.evidence.get(key) : undefined
    const text = failureText(payload)
    if (
      readRecord(payload).willRetry === false &&
      info?.error === 'other' &&
      previous?.phase === 'retry' &&
      text !== undefined &&
      previous.text === digest(text)
    ) {
      info = previous.info
    }
    const effective = {
      error: {
        ...readRecord(readRecord(payload).error),
        codexErrorInfo: info ? { [info.error]: { httpStatusCode: info.status } } : undefined
      }
    }
    const existing =
      this.usageLimits.failure(effective) ?? codexAuthenticationFailure(effective, account)
    if (existing) {
      // Sign-in advice must not quote provider text; the bounded frame retains diagnostics.
      return existing.kind === 'notSignedIn' ? { ...existing, detail: undefined } : existing
    }
    switch (info?.error ?? 'other') {
      case 'modelNotFound':
        return agentSessionFailureFact('modelUnavailable')
      case 'serverOverloaded':
      case 'flexUnavailable':
      case 'policyCapacityUnavailable':
        return agentSessionFailureFact('providerUnavailable')
      case 'cyberPolicy':
      case 'misalignmentPolicyViolation':
      case 'tooManyDenials':
        return agentSessionFailureFact('providerSafetyStopped')
      default:
        return agentSessionFailureFact('providerResponseFailed')
    }
  }

  private repeatsTerminal(payload: unknown, threadId: string, turnId: string): boolean {
    const key = scopeKey(threadId, turnId)
    const previous = key ? this.evidence.get(key) : undefined
    if (previous?.phase !== 'terminal') {
      return false
    }
    const next = terminalSignature(payload)
    return (
      (next.code === undefined || next.code === previous.signature.code) &&
      (next.message === undefined || next.message === previous.signature.message) &&
      (next.status === undefined || next.status === previous.signature.status)
    )
  }

  private admittedTerminal(payload: unknown, threadId: string, turnId: string | null): void {
    const key = scopeKey(threadId, turnId)
    if (key) {
      this.remember(key, { phase: 'terminal', signature: terminalSignature(payload) })
    }
  }

  forget(threadId: string, turnId: string): void {
    const key = scopeKey(threadId, turnId)
    if (key) {
      this.evidence.delete(key)
    }
  }

  dispose(): void {
    this.evidence.clear()
  }

  private remember(key: string, evidence: FailureEvidence): void {
    this.evidence.delete(key)
    this.evidence.set(key, evidence)
    if (this.evidence.size > MAX_CODEX_GENERIC_TURN_BUCKETS) {
      const oldest = this.evidence.keys().next().value
      if (oldest !== undefined) {
        this.evidence.delete(oldest)
      }
    }
  }
}
