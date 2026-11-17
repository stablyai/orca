import { afterEach, expect, it } from 'vitest'
import { createJournalReducerState } from './projection/journal-reducer'
import {
  insertJournalDomainImportedSubmission,
  restoredJournalDomainSubmissions
} from './journal-domain-import-submissions'
import { messageFixture, target } from './journal-sql-message.test-fixture'
import { domainLifecycleFixture, lifecycleIdentity } from './journal-domain-lifecycle.test-fixture'
import { journalSqlReads } from './journal-sql-reads'
import { readJournalSqlPoint } from './journal-sql-point-read'
import { readJournalDomainHistoryPage } from './journal-domain-history-page'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import {
  codexProviderHandle,
  agentSessionJournalProviderHandle
} from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { insertJournalDomainQueueRow, journalDomainQueueRow } from './journal-domain-queue-rows'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))

it('imports independent raw and outcome sources without creating public attempts, preserving exact fallback placement and handover recovery', async () => {
  const f = messageFixture()
  cleanup.push(() => f.db.close())
  const state = createJournalReducerState('chat', 'epoch')
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'image-ref', path: 'original.png' }]
  }
  state.inputs.sources.set('raw', {
    kind: 'submission',
    v: 4,
    epoch: 'epoch',
    seq: 2,
    ts: 20,
    fence: 1,
    clientMessageId: 'raw',
    body,
    payloadFingerprint: 'raw',
    providerHandle: agentSessionJournalProviderHandle({
      agent: 'codex',
      providerHandle: codexProviderHandle('thread')
    }),
    recovered: true,
    agentId: 'child',
    producerKind: 'agent',
    turnScope: { kind: 'unknown' }
  })
  state.inputs.sources.set('outcome', {
    kind: 'outcome-admission',
    epoch: 'epoch',
    sequence: 3,
    fence: 1,
    item: {
      itemId: 'orca:outcome',
      revision: 4,
      body,
      sequence: 3,
      sequenceIndex: 0,
      observedAt: 30,
      agentId: 'original-child',
      recovered: true,
      recoveredAt: 25
    },
    submission: {
      clientMessageId: 'outcome',
      fence: 1,
      payloadFingerprint: 'outcome',
      dispatchState: 'rejected',
      providerItemId: null,
      reason: 'rejected',
      submittedAt: 30,
      resolvedAt: 40
    }
  })
  for (const attempt of restoredJournalDomainSubmissions(state, () => false)) {
    insertJournalDomainImportedSubmission(f.db, target, attempt)
  }
  const reads = journalSqlReads(
    { point: async (request) => readJournalSqlPoint(f.db, request) },
    'chat'
  )
  expect(await reads.submission('raw')).toBeUndefined()
  expect(await reads.submission('outcome')).toBeUndefined()
  const originals: AgentJournalRenderItem[] = [
    {
      itemId: 'orca:raw',
      revision: 0,
      body,
      sequence: 2,
      observedAt: 20,
      recovered: true,
      recoveredAt: 20,
      turnScope: { kind: 'thread' },
      agentId: 'child',
      producerKind: 'agent'
    },
    {
      itemId: 'orca:outcome',
      revision: 4,
      body,
      sequence: 3,
      sequenceIndex: 0,
      observedAt: 30,
      agentId: 'original-child',
      recovered: true,
      recoveredAt: 25
    }
  ]
  expect(await reads.historySourceItems(['raw', 'outcome'])).toEqual(originals)
  const page = readJournalDomainHistoryPage(f.db, {
    sessionId: 'chat',
    direction: 'tail',
    reader: {
      form: 'client',
      queuedImages: {
        ids: [
          ['raw', true],
          ['outcome', true]
        ],
        imageIds: []
      }
    }
  }).page
  expect(page.items).toEqual(originals)
  expect(page.submissions).toEqual([])
  expect(page.hasOlder).toBe(false)
  state.inputs.handovers.set('outcome', {
    kind: 'dispatch',
    v: 4,
    epoch: 'epoch',
    seq: 8,
    ts: 80,
    fence: 1,
    clientMessageId: 'outcome',
    state: 'pending',
    providerItemId: null,
    reason: null,
    turnScope: { kind: 'turn', turnItemId: 'turn' }
  })
  f.db.exec('DELETE FROM journal_submission_attempts')
  for (const attempt of restoredJournalDomainSubmissions(state, () => false)) {
    insertJournalDomainImportedSubmission(f.db, target, attempt)
  }
  expect(await reads.historySourceItems(['outcome'])).toEqual([
    {
      itemId: 'orca:outcome',
      revision: 0,
      body,
      sequence: 8,
      observedAt: 80,
      turnScope: { kind: 'thread' },
      agentId: 'original-child'
    }
  ])
  const handover = state.inputs.handovers.get('outcome')!
  state.inputs.handovers.set('outcome', { ...handover, recovered: true })
  f.db.exec('DELETE FROM journal_submission_attempts')
  for (const attempt of restoredJournalDomainSubmissions(state, () => false)) {
    insertJournalDomainImportedSubmission(f.db, target, attempt)
  }
  expect(await reads.historySourceItems(['outcome'])).toEqual([
    {
      itemId: 'orca:outcome',
      revision: 0,
      body,
      sequence: 8,
      observedAt: 80,
      recovered: true,
      recoveredAt: 80,
      turnScope: { kind: 'thread' },
      agentId: 'original-child'
    }
  ])
  f.seedItem({
    itemId: 'orca:outcome',
    revision: 5,
    body: { kind: 'status', text: 'visible' },
    sequence: 9,
    observedAt: 90
  })
  expect((await reads.historySourceItems(['outcome']))[0]?.body).toEqual({
    kind: 'status',
    text: 'visible'
  })
  f.db.exec("UPDATE journal_items SET hidden=1,payload_json='invalid' WHERE item_id='orca:outcome'")
  expect((await reads.historySourceItems(['outcome']))[0]?.sequence).toBe(8)
})

it('retains returned sources through terminal dispatch, removal and reopen', async () => {
  const f = domainLifecycleFixture(cleanup)
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'original' }]
  }
  const fingerprint = agentSessionSendBodyFingerprint('chat', body)
  insertJournalDomainQueueRow(f.db, target, {
    messageId: 'card',
    body,
    position: 1,
    fingerprint,
    state: 'waiting',
    holdReason: null,
    returnedReason: null,
    returnedRejection: null,
    consumedAs: null,
    queuedAt: null
  })
  await f.run({
    kind: 'submission',
    input: {
      clientMessageId: 'send',
      body,
      payloadFingerprint: fingerprint,
      fence: 1,
      handoverRecorded: true
    },
    consume: { messageId: 'card', expect: 'waiting' }
  })
  await f.run({
    kind: 'dispatch',
    input: {
      clientMessageId: 'send',
      fence: 1,
      state: 'rejected',
      ...agentSessionFailureWords(
        { kind: 'notSignedIn', neverReachedAgent: true },
        { surface: 'rejection', agentName: 'Codex' }
      )
    }
  })
  expect(journalDomainQueueRow(f.db, target, 'card')?.card.state).toBe('returned')
  await f.run({ kind: 'tombstone', identity: lifecycleIdentity('send'), fence: 1 })
  f.reopen()
  const reads = journalSqlReads(
    { point: async (request) => readJournalSqlPoint(f.db, request) },
    'chat'
  )
  expect(await reads.historySourceItems(['send'])).toEqual([
    {
      itemId: 'orca:send',
      revision: 0,
      body,
      sequence: 1,
      observedAt: 100,
      turnScope: { kind: 'thread' }
    }
  ])
})
