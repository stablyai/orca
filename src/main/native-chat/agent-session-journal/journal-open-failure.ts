import type { AgentSessionRefusalReason } from '../../../shared/agent-session-refusal-details'
import { agentSessionWriteNoticeEnglish } from '../../../shared/agent-session-refusal-notice'
import {
  AgentSessionRefusalError,
  isAgentSessionRefusalError,
  refuse,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire-refusals'
import { isSqliteCorruption } from '../../sqlite/sqlite-read-failure'
import type { JournalLoad } from './journal-open'
import { AgentSessionJournalError } from './journal-write-guards'
import type { StructuredAgentSessionLogger } from '../agent-session-wire/structured-agent-session-logger'

type JournalRefusalReason = AgentSessionRefusalReason<'agent_session_journal_unreadable'>

export type JournalOpenFailure = Exclude<JournalRefusalReason, 'journalWrittenByNewerOrca'>

export class JournalDamageError extends Error {
  override readonly name = 'JournalDamageError'
}

/** Newer content outranks adjacent damage; refuse unreadable history without deleting rows. */
export function failLoadOnUnloadableJournal(sessionId: string, load: JournalLoad): void {
  if (load.newer) {
    throw journalOpenRefusalError(
      new AgentSessionJournalError(
        'journal_read_only',
        `journal of ${sessionId} holds a newer Orca's row at sequence ${load.newer.sequence}`
      )
    )
  }
  if (!load.damage) {
    return
  }
  const { sequence, cause } = load.damage
  throw journalOpenRefusalError(
    new JournalDamageError(`journal of ${sessionId} is damaged at sequence ${sequence}: ${cause}`)
  )
}

export class JournalUnreleasedSchemaError extends Error {
  override readonly name = 'JournalUnreleasedSchemaError'
}

// Bound cyclic error-cause chains.
const MAX_CAUSE_DEPTH = 8

/** Only proven corruption or unreleased schemas are permanent; unproven failures may clear. */
export function classifyJournalOpenFailure(error: unknown): JournalOpenFailure {
  let current = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth += 1) {
    if (
      isSqliteCorruption(current) ||
      current instanceof JournalDamageError ||
      current instanceof JournalUnreleasedSchemaError
    ) {
      return 'journalCorrupt'
    }
    current = current instanceof Error ? current.cause : undefined
  }
  return 'journalUnavailable'
}

// Released clients print these messages for sends and Stops.
const JOURNAL_OPEN_MESSAGE: Record<JournalRefusalReason, string> = {
  journalCorrupt: agentSessionWriteNoticeEnglish(['historyUnusable']),
  journalUnavailable: agentSessionWriteNoticeEnglish(['historyUnavailable', 'tryAgain']),
  journalWrittenByNewerOrca: agentSessionWriteNoticeEnglish([
    'savedByNewerOrca',
    'updateOrcaToKeepUsing'
  ])
}

export const JOURNAL_NEWER_SCHEMA_MESSAGE = JOURNAL_OPEN_MESSAGE.journalWrittenByNewerOrca

export function isJournalWrittenByNewerOrca(error: unknown): boolean {
  return error instanceof AgentSessionJournalError && error.code === 'journal_read_only'
}

function journalRefusalReason(error: unknown): JournalRefusalReason {
  return isJournalWrittenByNewerOrca(error)
    ? 'journalWrittenByNewerOrca'
    : classifyJournalOpenFailure(error)
}

function journalOpenFailureWords(error: unknown): {
  reason: JournalRefusalReason
  message: string
} {
  const reason = journalRefusalReason(error)
  return { reason, message: JOURNAL_OPEN_MESSAGE[reason] }
}

/** Preserve preclassified refusals; their original cause is not available for reclassification. */
export function journalOpenRefusal(error: unknown): AgentSessionWireRefusal {
  if (isAgentSessionRefusalError(error)) {
    return error.refusal
  }
  const { reason, message } = journalOpenFailureWords(error)
  return refuse('agent_session_journal_unreadable', { reason }, message)
}

export async function refusingNewerOrcaJournal<TOutcome>(
  run: Promise<TOutcome>
): Promise<TOutcome | { ok: false; refusal: AgentSessionWireRefusal }> {
  try {
    return await run
  } catch (error) {
    if (isJournalWrittenByNewerOrca(error)) {
      return { ok: false, refusal: journalOpenRefusal(error) }
    }
    throw error
  }
}

/** Preserve the original storage failure as a loggable cause. */
export function journalOpenRefusalError(error: unknown): AgentSessionRefusalError {
  if (isAgentSessionRefusalError(error)) {
    return error
  }
  const { reason, message } = journalOpenFailureWords(error)
  return new AgentSessionRefusalError(
    refuse('agent_session_journal_unreadable', { reason }, message),
    { cause: error }
  )
}

/** Keep storage paths/details in logs; readers receive only classified refusal codes. */
export function journalOpenReadRefusal(
  error: unknown,
  logger: StructuredAgentSessionLogger,
  sessionId: string
): AgentSessionRefusalError {
  if (isAgentSessionRefusalError(error)) {
    return error
  }
  return unreadableRefusal(error, journalRefusalReason(error), { logger, sessionId })
}

const MAX_LOGGED_SESSIONS = 256

/** Reconnecting readers log once per session until failure changes or the session opens. */
export function createJournalOpenReadRefusals(logger: StructuredAgentSessionLogger) {
  const logged = new Map<string, string>()
  const firstSeen = (sessionId: string, failure: string): boolean => {
    const repeat = logged.get(sessionId) === failure
    // At capacity, log new sessions repeatedly rather than evicting another session's failure.
    if (!repeat && (logged.has(sessionId) || logged.size < MAX_LOGGED_SESSIONS)) {
      logged.set(sessionId, failure)
    }
    return !repeat
  }
  return {
    refusal: (sessionId: string, error: unknown): AgentSessionRefusalError => {
      if (isAgentSessionRefusalError(error)) {
        const { refusal } = error
        const cause = error.cause instanceof Error ? error.cause.message : String(error.cause)
        if (
          refusal.code === 'agent_session_journal_unreadable' &&
          firstSeen(sessionId, `${refusal.details?.reason}:${cause}`)
        ) {
          logOpenForReadFailure(logger, sessionId, error)
        }
        return error
      }
      const reason = journalRefusalReason(error)
      const failure = `${reason}:${error instanceof Error ? error.message : String(error)}`
      const log = firstSeen(sessionId, failure) ? { logger, sessionId } : null
      return unreadableRefusal(error, reason, log)
    },
    forget: (sessionId: string): void => {
      logged.delete(sessionId)
    }
  }
}

function unreadableRefusal(
  error: unknown,
  reason: JournalRefusalReason,
  log: { logger: StructuredAgentSessionLogger; sessionId: string } | null
): AgentSessionRefusalError {
  if (log) {
    logOpenForReadFailure(log.logger, log.sessionId, error)
  }
  const code = 'agent_session_journal_unreadable'
  return new AgentSessionRefusalError(refuse(code, { reason }, code), { cause: error })
}

function logOpenForReadFailure(
  logger: StructuredAgentSessionLogger,
  sessionId: string,
  error: unknown
): void {
  logger.warn('opening the conversation for a read failed', {
    scope: 'open-for-read',
    sessionId,
    error
  })
}
