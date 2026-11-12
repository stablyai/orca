import { readJournalSqlPoint } from './journal-sql-point-read'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import {
  codexProviderHandle,
  agentSessionJournalProviderHandle
} from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { JournalRow } from './durable-rows/journal-row-schema'
import { insertJournalRow, publishJournalSessionEpoch } from './durable-rows/journal-row-table'
import { openJournalDatabase, runJournalTransaction } from './database/journal-database'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { prepareJournalDomainImport } from './journal-domain-import'
import {
  finishJournalDomainImport,
  insertJournalDomainImportPage
} from './journal-domain-import-rows'
import { JournalSqlScope } from './journal-sql-scope'
import { JournalSqlStatusContext } from './journal-sql-status-context'
import { readJournalSqlStatusState } from './journal-sql-status-state'
import { readJournalSqlStatusIndicators } from './journal-sql-status-indicators'
import { readJournalSqlInput } from './journal-sql-input-reads'
import { readJournalSqlWork } from './journal-sql-work-read'
import { readJournalSqlObserver } from './journal-sql-observer-read'
import { readJournalDomainAcceptedSendUnopened } from './journal-domain-accepted-unopened'
import { readJournalSqlUsageLimitCut, readJournalSqlOrcaStopCut } from './journal-sql-status-cuts'

const target = { sessionId: 'chat', epoch: 'epoch' }
const providerHandle = agentSessionJournalProviderHandle({
  agent: 'codex',
  providerHandle: codexProviderHandle('thread')
})
const base = { v: 4 as const, epoch: 'epoch', seq: 1, ts: 100, fence: 1 }
const message = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

it('answers opening and owed phase membership in one work snapshot and honors a hidden newer raw turn', () => {
  const { db, context } = fixture([
    {
      ...base,
      kind: 'submission',
      clientMessageId: 'send',
      payloadFingerprint: 'fp',
      body: message('Go'),
      providerHandle,
      handoverRecorded: true,
      origin: 'client'
    },
    {
      ...base,
      kind: 'dispatch',
      clientMessageId: 'send',
      state: 'pending',
      providerItemId: null,
      reason: null
    }
  ])
  const authority = {
    handle: 'owner',
    record: {
      currentFence: 1,
      ownerObservation: { claimStatus: 'live' as const, unreconciled: false, handoffStage: null }
    },
    child: { fence: 1 },
    handingOver: [],
    continuingUnadmitted: [],
    finalizing: [],
    openedThrough: { epoch: 'epoch', sequence: 0 },
    operationalRevision: 0
  }
  const read = (fence: number) =>
    readJournalSqlWork(context(), {
      authority,
      operation: { kind: 'opening-send', fence }
    }).result
  expect(read(1)).toEqual({ kind: 'opening-send', opening: true })
  expect(read(2)).toEqual({ kind: 'opening-send', opening: false })
  expect(
    readJournalSqlWork(context(), { authority, operation: { kind: 'state' } }).result
  ).toMatchObject({
    kind: 'state',
    state: {
      owedEnteredSubmissions: [{ clientMessageId: 'send' }],
      owedSendingSubmissions: [{ clientMessageId: 'send' }]
    }
  })
  db.exec(`UPDATE journal_items SET hidden=1,turn_marker=1,context_clear=0,root=1,
    sequence=99 WHERE item_id='orca:send'`)
  expect(read(1)).toEqual({ kind: 'opening-send', opening: false })
  const sql = vi.spyOn(db, 'prepare')
  const input = readJournalSqlPoint(db, {
    sessionId: 'chat',
    operation: {
      kind: 'work',
      input: {
        authority,
        operation: { kind: 'input', now: 100, facts: { reopenFloor: null }, allowSteer: false }
      }
    }
  })
  expect(input).toMatchObject({
    kind: 'work',
    answer: { result: { kind: 'input', state: { working: true }, queue: { card: null } } }
  })
  const seeks = [
    ...new Set(
      sql.mock.calls
        .map(([query]) => query)
        .filter(
          (query) =>
            query.includes('raw_boundary AS') ||
            query.includes('AS work_floor') ||
            query.includes('payload_json FROM journal_submission_attempts')
        )
    )
  ]
  sql.mockRestore()
  const plans = seeks.map((query) =>
    db
      .prepare(`EXPLAIN QUERY PLAN ${query}`)
      .all()
      .map((row) => String(row.detail))
      .join('\n')
  )
  expect(plans.join('\n')).toContain('journal_items_raw_turn_marker')
  expect(plans.join('\n')).toContain('journal_items_turn_marker')
  expect(plans.join('\n')).toContain('journal_items_status_pending')
  expect(plans.join('\n')).toContain('journal_items_context_clear')
  expect(plans.join('\n')).toContain('journal_items_raw_context_clear')
  expect(plans.join('\n')).toContain('journal_submission_unsettled')
  for (const plan of plans) {
    expect(plan).not.toMatch(/SCAN (?:journal_items|item|source)\b|TEMP B-TREE/)
  }
  const resolved = readJournalSqlWork(context(), { authority, operation: { kind: 'state' } })
  const resolvedQueue = () =>
    readJournalSqlPoint(db, {
      sessionId: 'chat',
      operation: {
        kind: 'queue',
        operation: {
          kind: 'eligible-input-card',
          authority,
          now: 100,
          facts: { reopenFloor: null },
          allowSteer: false,
          resolved
        }
      }
    })
  expect(resolvedQueue()).toMatchObject({
    kind: 'queue',
    result: {
      kind: 'eligible-input-card',
      card: null,
      work: { result: { kind: 'input', state: { working: true }, queue: { card: null } } }
    }
  })
  db.prepare(
    "INSERT INTO agent_session_records(session_id,record_json) VALUES ('chat','unreadable')"
  ).run()
  expect(
    readJournalSqlPoint(db, {
      sessionId: 'chat',
      operation: {
        kind: 'work',
        input: {
          authority,
          operation: { kind: 'input', now: 100, facts: { reopenFloor: null }, allowSteer: false }
        }
      }
    })
  ).toMatchObject({
    kind: 'work',
    answer: {
      result: {
        state: { working: true },
        queue: { failure: { message: expect.stringContaining('JSON') } }
      }
    }
  })
  expect(resolvedQueue()).toMatchObject({
    kind: 'queue',
    result: {
      work: {
        result: {
          state: { working: true },
          queue: { failure: { message: expect.stringContaining('JSON') } }
        }
      }
    }
  })
})
const cleanup: Database.Database[] = []
afterEach(() => {
  for (const db of cleanup.splice(0)) {
    db.close()
  }
})

function fixture(rows: JournalRow[]) {
  const { db: source } = openJournalDatabase(':memory:')
  cleanup.push(source)
  runJournalTransaction(source, () => {
    publishJournalSessionEpoch(source, { sessionId: 'chat', workspaceId: 'workspace' }, 'epoch')
    insertJournalRow(source, 'chat', {
      ...base,
      kind: 'epoch',
      reason: 'session_created',
      providerHandle
    })
    rows.forEach((row, index) =>
      insertJournalRow(source, 'chat', { ...row, seq: index + 2, ts: (index + 2) * 100 })
    )
  })
  const imported = prepareJournalDomainImport(source, 'chat')!
  const db = new Database(':memory:')
  cleanup.push(db)
  migrateJournalDomainSchema(db)
  runJournalTransaction(db, () => {
    for (const page of imported.pages) {
      insertJournalDomainImportPage(db, target, page)
    }
    finishJournalDomainImport(db, imported)
  })
  const scope = () => new JournalSqlScope(db, 'chat', 'epoch')
  return { db, scope, context: () => new JournalSqlStatusContext(scope()) }
}

it('reads imported attention, live execution ownership and aliased legacy openers without projection tables', () => {
  const { db, scope, context } = fixture([
    {
      ...base,
      kind: 'submission',
      clientMessageId: 'send',
      payloadFingerprint: 'fp',
      body: message('Go'),
      providerHandle,
      handoverRecorded: true,
      origin: 'client',
      source: { kind: 'user' }
    },
    {
      ...base,
      kind: 'dispatch',
      clientMessageId: 'send',
      state: 'accepted',
      providerItemId: 'codex:thread:echo',
      reason: null
    },
    {
      ...base,
      kind: 'item',
      itemId: 'legacy-turn',
      revision: 1,
      ownerFence: 1,
      executionOwner: 2,
      body: {
        kind: 'status',
        text: 'Working',
        turnLifecycle: {
          turnId: 'live',
          state: 'running',
          requestedAt: 400,
          userItemId: 'codex:thread:echo'
        }
      }
    },
    {
      ...base,
      kind: 'item',
      itemId: 'question',
      revision: 1,
      executionOwner: 2,
      body: {
        kind: 'question',
        question: 'Continue?',
        options: [],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      }
    },
    {
      ...base,
      kind: 'item',
      itemId: 'prose',
      revision: 1,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Ready' }] }
    },
    {
      ...base,
      kind: 'item',
      itemId: 'tool-only',
      revision: 1,
      body: { kind: 'message', role: 'assistant', blocks: [] }
    }
  ])
  const authority = {
    handle: 'owner',
    record: {
      currentFence: 2,
      ownerObservation: { claimStatus: 'live' as const, unreconciled: false, handoffStage: null }
    },
    child: { fence: 2 },
    handingOver: [],
    continuingUnadmitted: [],
    finalizing: [],
    openedThrough: { epoch: 'epoch', sequence: 0 },
    operationalRevision: 0,
    stopRevision: 0,
    stop: null,
    reopenFloor: null
  }
  const observer = readJournalSqlObserver(context(), {
    authority,
    start: 0,
    firstInputSubmissionKey: null
  })
  expect(observer.state).toEqual({
    summary: {
      status: 'attention',
      latestPrompt: 'Go',
      lastAssistantMessage: 'Ready',
      statusStartedAt: 500
    },
    latestRequest: {
      kind: 'turn',
      id: 'live',
      turnState: 'running',
      outcome: null,
      settledAt: undefined
    },
    owesWork: true,
    pendingPromptIds: ['question']
  })
  expect(observer.work.activeTurn?.turnId).toBe('live')
  expect(observer.indicators).toEqual({
    acceptedSendKey: 'epoch:send',
    firstInputSubmissionKey: '["epoch","send"]',
    submissionCount: 1,
    stopping: false
  })
  expect(readJournalDomainAcceptedSendUnopened(scope())).toBe(false)
  db.prepare(`UPDATE journal_items SET hidden=1 WHERE item_id='legacy-turn'`).run()
  expect(
    readJournalSqlWork(context(), { authority, operation: { kind: 'turn' } }).result
  ).toMatchObject({ kind: 'turn', activeTurn: { turnId: 'live' }, working: true })
  expect(readJournalSqlInput(scope(), { kind: 'newest-turn' })).toMatchObject({
    kind: 'newest-turn',
    turn: { turnId: 'live', state: 'running' }
  })
  db.prepare(`DELETE FROM journal_items WHERE item_id='legacy-turn'`).run()
  expect(readJournalDomainAcceptedSendUnopened(scope())).toBe(true)
  expect(readJournalSqlInput(scope(), { kind: 'accepted-submissions' })).toMatchObject({
    kind: 'accepted-submissions',
    latestReceiptSequence: 3,
    submissions: [{ clientMessageId: 'send', dispatchState: 'accepted' }]
  })
  db.prepare(`UPDATE journal_items SET hidden=1,context_clear=1,turn_marker=1,
    kind='status',message_role=NULL,payload_json=? WHERE item_id='tool-only'`).run(
    JSON.stringify({
      itemId: 'tool-only',
      revision: 2,
      sequence: 7,
      observedAt: 700,
      body: {
        kind: 'status',
        text: 'Cleared',
        contextClear: { operationId: 'clear', afterFence: 2, clearedAt: 700 }
      }
    })
  )
  const cleared = readJournalSqlObserver(context(), {
    authority,
    start: 0,
    firstInputSubmissionKey: null
  })
  expect(cleared.state.summary.latestPrompt).toBe('Go')
  expect(cleared.indicators.firstInputSubmissionKey).toBeNull()
})

it('keeps every outstanding input across finite pages and retains end evidence after its source item is removed', () => {
  const rows: JournalRow[] = []
  for (let i = 0; i < 130; i++) {
    rows.push({
      ...base,
      kind: 'submission',
      clientMessageId: `send-${i}`,
      payloadFingerprint: `fp-${i}`,
      body: message('Go'),
      providerHandle
    })
  }
  rows.push(
    {
      ...base,
      kind: 'item',
      itemId: 'ended',
      revision: 1,
      body: {
        kind: 'turn',
        turnId: 'ended',
        state: 'completed',
        outcome: 'success',
        userItemId: 'orca:send-129'
      }
    },
    { ...base, kind: 'tombstone', itemId: 'ended', revision: 2 }
  )
  const { scope, context } = fixture(rows)
  const input = readJournalSqlInput(scope(), {
    kind: 'batch',
    reads: [
      { kind: 'pending-submissions' },
      { kind: 'sending-submissions' },
      { kind: 'entered-submissions' }
    ]
  })
  if (input.kind !== 'batch') {
    throw new Error('expected submissions')
  }
  for (const result of input.results) {
    if (!('submissions' in result)) {
      throw new Error('expected submissions')
    }
    expect(result.submissions).toHaveLength(130)
    expect(result.submissions.at(-1)).toMatchObject({
      clientMessageId: 'send-129',
      fence: 1,
      payloadFingerprint: 'fp-129',
      dispatchState: 'pending',
      providerItemId: null,
      reason: null,
      submittedAt: 13100,
      resolvedAt: null,
      submittedSequence: 131
    })
  }
  const authority = {
    handle: 'owner',
    record: null,
    child: { fence: 0, heldSends: [] },
    handingOver: [],
    continuingUnadmitted: [],
    finalizing: [],
    openedThrough: { epoch: 'epoch', sequence: 0 },
    operationalRevision: 0
  }
  expect(
    readJournalSqlWork(context(), {
      authority,
      operation: { kind: 'attempt-ended', clientMessageId: 'send-129' }
    }).result
  ).toEqual({ kind: 'attempt-ended', ended: true })
  expect(
    readJournalSqlInput(scope(), { kind: 'capture-keys', present: ['rendered-only'] })
  ).toMatchObject({
    kind: 'capture-keys',
    keys: expect.arrayContaining(['orca:send-0', 'orca:send-129', 'rendered-only'])
  })
})

it('uses scoped failure facts for cuts and request outcomes', () => {
  const { context, db } = fixture([
    { ...base, kind: 'item', itemId: 'ask', revision: 1, body: message('Go') },
    {
      ...base,
      kind: 'item',
      itemId: 'turn',
      revision: 1,
      body: {
        kind: 'turn',
        turnId: 'limited',
        state: 'completed',
        outcome: 'failure',
        completedAt: 300
      }
    },
    {
      ...base,
      kind: 'item',
      itemId: 'limit',
      revision: 1,
      turnScope: { kind: 'turn', turnItemId: 'turn' },
      body: {
        kind: 'status',
        ...agentSessionFailureWords(
          { kind: 'usageLimitReached', usageLimit: { resetsAt: 999 } },
          { surface: 'row' }
        )
      }
    }
  ])
  expect(readJournalSqlUsageLimitCut(context())).toEqual({
    turnItemId: 'turn',
    resetsAt: 999,
    turnEndedAt: 300,
    chain: 0
  })
  expect(readJournalSqlStatusState(context()).summary).toMatchObject({
    status: 'idle',
    turnOutcome: 'failure'
  })
  db.prepare(
    `UPDATE journal_items SET payload_json=?,lifecycle_state='interrupted' WHERE item_id='turn'`
  ).run(
    JSON.stringify({
      itemId: 'turn',
      revision: 2,
      sequence: 3,
      observedAt: 300,
      body: { kind: 'turn', turnId: 'limited', state: 'interrupted', completedAt: 300 }
    })
  )
  db.prepare(`UPDATE journal_items SET payload_json=? WHERE item_id='limit'`).run(
    JSON.stringify({
      itemId: 'limit',
      revision: 2,
      sequence: 4,
      observedAt: 400,
      turnScope: { kind: 'turn', turnItemId: 'turn' },
      body: { kind: 'status', text: 'Quit', orcaStop: { cause: 'quit' } }
    })
  )
  expect(readJournalSqlOrcaStopCut(context())).toEqual({ turnItemId: 'turn', cause: 'quit' })
  expect(readJournalSqlStatusState(context()).summary).toMatchObject({
    status: 'idle',
    turnOutcome: 'cancellation'
  })
  expect(readJournalSqlStatusIndicators(context(), { start: 0, floor: 0 })).toMatchObject({
    submissionCount: 0,
    firstInputSubmissionKey: null
  })
})

it('reopens stopped history when its only effective carrier is excluded and retains historical handover after removal', () => {
  const rows: JournalRow[] = []
  for (const id of ['first', 'second', 'carrier', 'refused']) {
    rows.push({
      ...base,
      kind: 'submission',
      clientMessageId: id,
      payloadFingerprint: id,
      providerHandle,
      body: message(id),
      handoverRecorded: true,
      origin: 'client',
      source: { kind: 'user' }
    })
    if (id === 'first' || id === 'second') {
      rows.push({
        ...base,
        kind: 'dispatch',
        clientMessageId: id,
        state: 'rejected',
        providerItemId: null,
        reason: null,
        rejection: { kind: 'cancelled', neverReachedAgent: true }
      })
      continue
    }
    rows.push(
      {
        ...base,
        kind: 'dispatch',
        clientMessageId: id,
        state: 'pending',
        providerItemId: null,
        reason: null,
        carries: ['first', 'second']
      },
      {
        ...base,
        kind: 'dispatch',
        clientMessageId: id,
        state: id === 'carrier' ? 'accepted' : 'rejected',
        providerItemId: null,
        reason: null,
        ...(id === 'refused' ? { rejection: { kind: 'writeFailed' as const } } : {})
      }
    )
    if (id === 'carrier') {
      rows.push({ ...base, kind: 'tombstone', itemId: 'orca:carrier', revision: 2 })
    }
  }
  const { scope } = fixture(rows)
  expect(
    readJournalSqlInput(scope(), { kind: 'stopped-history-inputs', excluding: 'unrelated' })
  ).toEqual({ kind: 'stopped-history-inputs', submissions: [] })
  const uncovered = readJournalSqlInput(scope(), {
    kind: 'stopped-history-inputs',
    excluding: 'carrier',
    afterSequence: 2
  })
  if (uncovered.kind !== 'stopped-history-inputs') {
    throw new Error('expected stopped history')
  }
  expect(uncovered.submissions.map((input) => input.clientMessageId)).toEqual(['second'])
  expect(readJournalSqlInput(scope(), { kind: 'latest-accepted-handover' })).toEqual({
    kind: 'latest-accepted-handover',
    sequence: 7
  })
})

it('keeps sending phase re-entry separate from entered and pending admission order', () => {
  const submission = (id: string, held = false): JournalRow => ({
    ...base,
    kind: 'submission',
    clientMessageId: id,
    payloadFingerprint: id,
    providerHandle,
    body: message(id),
    ...(held ? { handoverRecorded: true } : {})
  })
  const dispatch = (state: 'pending' | 'unknown'): JournalRow => ({
    ...base,
    kind: 'dispatch',
    clientMessageId: 'a',
    state,
    providerItemId: null,
    reason: null
  })
  const { scope } = fixture([
    submission('a', true),
    submission('b'),
    dispatch('pending'),
    submission('c'),
    dispatch('unknown'),
    dispatch('pending'),
    dispatch('pending')
  ])
  const result = readJournalSqlInput(scope(), {
    kind: 'batch',
    reads: [
      { kind: 'sending-submissions' },
      { kind: 'entered-submissions' },
      { kind: 'pending-submissions' }
    ]
  })
  if (result.kind !== 'batch') {
    throw new Error('expected batch')
  }
  expect(
    result.results.map((read) =>
      'submissions' in read ? read.submissions.map((input) => input.clientMessageId) : []
    )
  ).toEqual([
    ['a', 'b', 'c'],
    ['a', 'b', 'c'],
    ['a', 'b', 'c']
  ])
})
