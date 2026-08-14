import { describe, expect, it } from 'vitest'
import type { MessageRow } from './types'
import {
  buildWedgedWorkerEscalation,
  isEscalationSupersededByProgress,
  readWedgedWorkerEscalationRecord,
  WEDGED_WORKER_SIGNAL_KIND
} from './wedged-worker-escalation'
import type { WorkerProgressAssessment } from './worker-progress-evidence'
import { DEFAULT_WORKER_PROGRESS_THRESHOLDS } from './worker-progress-thresholds'

// 2026-08-13T08:57:01.400Z — a moment that does not sit on a whole second, which is the
// only kind that tells a truncated stamp apart from an exact one.
const ESCALATED_AT_MS = Date.UTC(2026, 7, 13, 8, 57, 1, 400)
const TRUNCATED_CREATED_AT = '2026-08-13 08:57:01'

function assessment(): WorkerProgressAssessment {
  return {
    dispatchId: 'dispatch_1',
    runId: 'run_1',
    taskId: 'task_1',
    status: 'wedged',
    reason: 'no_progress_evidence',
    quietMs: 16 * 60_000,
    lastProgressAtEpochMs: ESCALATED_AT_MS - 16 * 60_000,
    observed: ['terminal_output'],
    absent: ['heartbeat'],
    agentState: 'working'
  }
}

function messageRow(payload: string | null): MessageRow {
  return {
    id: 'message_1',
    run_id: 'run_1',
    from_handle: 'dispatch:dispatch_1',
    to_handle: 'run:run_1',
    subject: 'Worker dispatch_1 may be wedged',
    body: 'body',
    type: 'escalation',
    priority: 'high',
    thread_id: null,
    payload,
    read: 0,
    sequence: 1,
    created_at: TRUNCATED_CREATED_AT,
    delivered_at: null,
    sender_pane_key: null
  }
}

function escalationPayload(escalatedAtEpochMs: number): string {
  return buildWedgedWorkerEscalation({
    assessment: assessment(),
    escalationCount: 1,
    escalatedAtEpochMs,
    thresholds: DEFAULT_WORKER_PROGRESS_THRESHOLDS
  }).payload
}

describe('wedged worker escalation records', () => {
  it('carries the exact escalation instant in the payload', () => {
    const payload = JSON.parse(escalationPayload(ESCALATED_AT_MS))
    expect(payload).toMatchObject({
      kind: WEDGED_WORKER_SIGNAL_KIND,
      wedgedWorker: { escalationCount: 1, escalatedAtEpochMs: ESCALATED_AT_MS }
    })
  })

  it('reads the exact instant back rather than the second the row was stamped in', () => {
    const record = readWedgedWorkerEscalationRecord(messageRow(escalationPayload(ESCALATED_AT_MS)))
    expect(record).toEqual({
      escalationCount: 1,
      escalatedAtEpochMs: ESCALATED_AT_MS,
      escalatedAtIsTruncated: false
    })
  })

  // Why this matters: with only the truncated `created_at` the reader loses up to a
  // second, and the tolerance that hides the loss then swallows real progress made
  // inside that window. A worker that resumed is read as the same unchanged wedge.
  it('accepts progress made moments after an exactly stamped escalation', () => {
    const record = readWedgedWorkerEscalationRecord(messageRow(escalationPayload(ESCALATED_AT_MS)))
    expect(record).toBeDefined()
    expect(isEscalationSupersededByProgress(record!, ESCALATED_AT_MS + 200)).toBe(true)
    expect(isEscalationSupersededByProgress(record!, ESCALATED_AT_MS)).toBe(false)
    expect(isEscalationSupersededByProgress(record!, ESCALATED_AT_MS - 200)).toBe(false)
  })

  // Why keep the fallback: rows written before this field exists carry only `created_at`,
  // and a restart must still read their count and cadence.
  it('falls back to the row stamp, with its tolerance, for a record that predates the field', () => {
    const legacy = JSON.parse(escalationPayload(ESCALATED_AT_MS))
    delete legacy.wedgedWorker.escalatedAtEpochMs
    const record = readWedgedWorkerEscalationRecord(messageRow(JSON.stringify(legacy)))
    const stampedAt = Date.parse(`${TRUNCATED_CREATED_AT.replace(' ', 'T')}Z`)
    expect(record).toEqual({
      escalationCount: 1,
      escalatedAtEpochMs: stampedAt,
      escalatedAtIsTruncated: true
    })
    expect(isEscalationSupersededByProgress(record!, stampedAt + 900)).toBe(false)
    expect(isEscalationSupersededByProgress(record!, stampedAt + 1_100)).toBe(true)
  })

  it('ignores a message that is not a wedged-worker signal', () => {
    expect(readWedgedWorkerEscalationRecord(undefined)).toBeUndefined()
    expect(readWedgedWorkerEscalationRecord(messageRow(null))).toBeUndefined()
    expect(readWedgedWorkerEscalationRecord(messageRow('not json'))).toBeUndefined()
    expect(
      readWedgedWorkerEscalationRecord(messageRow(JSON.stringify({ kind: 'other' })))
    ).toBeUndefined()
  })
})
