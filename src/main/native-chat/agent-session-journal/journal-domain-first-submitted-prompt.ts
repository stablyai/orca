import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { firstStructuredAgentSessionPrompt } from '../../../shared/agent-session/requests/structured-agent-session-first-prompt'
import type { JournalSqlScope } from './journal-sql-scope'

export type JournalFirstSubmittedPrompt =
  | { kind: 'found'; prompt: string; submittedAt: number; sequence: number }
  | { kind: 'none' }
  /** The scan bound was reached before a qualifying message: not proof that none exists. */
  | { kind: 'incomplete' }

const FIRST_SUBMITTED_PROMPT_SCAN_LIMIT = 512
// Small first pages keep an early answer from reading ahead; doubling keeps long text-less runs cheap.
const FIRST_SUBMISSION_PAGE = 4
const MAX_SUBMISSION_PAGE = 64

const USER_ITEM = `i.hidden=0 AND i.root=1 AND i.kind='message' AND i.message_role='user'
  AND i.command_entry=0`

/** This session's live submissions in time order from a cursor: a range seek on journal_submission_order. */
const FIRST_SUBMITTED_PROMPT_SUBMISSIONS_SQL = `SELECT item_id, submitted_at, ordinal, message_id
FROM journal_submission_attempts INDEXED BY journal_submission_order
WHERE session_id=? AND epoch=? AND current=1 AND request_failure=0
  AND (submitted_at, ordinal, message_id) > (?, ?, ?)
ORDER BY submitted_at, ordinal, message_id LIMIT ?`

/** The user item one submission names, directly or through a provider alias: keyed lookups only. */
const FIRST_SUBMITTED_PROMPT_ITEM_SQL = `SELECT i.payload_json AS payload_json,
  i.sequence AS sequence, i.sequence_index AS sequence_index, i.ordinal AS ordinal
FROM journal_items i
WHERE i.session_id=? AND i.epoch=? AND i.item_id=? AND ${USER_ITEM}
  AND NOT EXISTS (SELECT 1 FROM journal_item_aliases o
    WHERE o.session_id=? AND o.epoch=? AND o.provider_item_id=i.item_id)
UNION ALL
SELECT i.payload_json, i.sequence, i.sequence_index, i.ordinal
FROM journal_item_aliases a INDEXED BY journal_item_aliases_target
CROSS JOIN journal_items i ON i.session_id=? AND i.epoch=? AND i.item_id=a.provider_item_id
WHERE a.session_id=? AND a.epoch=? AND a.item_id=? AND ${USER_ITEM}`

type Candidate = {
  prompt: string
  submittedAt: number
  sequence: number
  sequenceIndex: number
  ordinal: number
}

function precedes(left: Candidate, right: Candidate): boolean {
  return (
    (left.sequence - right.sequence ||
      left.sequenceIndex - right.sequenceIndex ||
      left.ordinal - right.ordinal) < 0
  )
}

/** The earliest user message submitted at/after `sinceMs`, by submission time across context clears.
 *  Unlike the naming prompt this ignores the latest-clear floor; items without a submission row never qualify.
 *  Walks submissions in time order and stops once the earliest text-bearing time group is complete, so
 *  later history is never read. */
export function readJournalDomainFirstSubmittedPrompt(
  scope: JournalSqlScope,
  sinceMs: number
): JournalFirstSubmittedPrompt {
  const [sessionId, epoch] = scope.prefix
  const submissions = scope.db.prepare(FIRST_SUBMITTED_PROMPT_SUBMISSIONS_SQL)
  const items = scope.db.prepare(FIRST_SUBMITTED_PROMPT_ITEM_SQL)
  const found = (best: Candidate): JournalFirstSubmittedPrompt => ({
    kind: 'found',
    prompt: best.prompt,
    submittedAt: best.submittedAt,
    sequence: best.sequence
  })
  let after: [number, number, string] = [sinceMs, Number.MIN_SAFE_INTEGER, '']
  let scanned = 0
  let best: Candidate | null = null
  let pageSize = FIRST_SUBMISSION_PAGE
  for (;;) {
    const page = submissions.all(sessionId, epoch, ...after, pageSize)
    for (const row of page) {
      const sent = scope.examined(row)
      const submittedAt = Number(sent.submitted_at)
      // Ties at the earliest time resolve by sequence; anything later cannot win.
      if (best && submittedAt > best.submittedAt) {
        return found(best)
      }
      if (++scanned > FIRST_SUBMITTED_PROMPT_SCAN_LIMIT) {
        return { kind: 'incomplete' }
      }
      const itemId = String(sent.item_id)
      for (const match of items.all(
        sessionId,
        epoch,
        itemId,
        sessionId,
        epoch,
        sessionId,
        epoch,
        sessionId,
        epoch,
        itemId
      )) {
        const examined = scope.examined(match)
        const prompt = firstStructuredAgentSessionPrompt([
          scope.decode<AgentJournalRenderItem>(examined.payload_json)
        ])
        if (!prompt) {
          continue
        }
        const candidate: Candidate = {
          prompt,
          submittedAt,
          sequence: Number(examined.sequence),
          sequenceIndex: Number(examined.sequence_index),
          ordinal: Number(examined.ordinal)
        }
        if (!best || precedes(candidate, best)) {
          best = candidate
        }
      }
      after = [submittedAt, Number(sent.ordinal), String(sent.message_id)]
    }
    if (page.length < pageSize) {
      return best ? found(best) : { kind: 'none' }
    }
    pageSize = Math.min(pageSize * 2, MAX_SUBMISSION_PAGE)
  }
}
