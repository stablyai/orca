import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { writeJournalDomainCurrentItem } from './journal-domain-current-item'
import { readJournalDomainItems, type JournalDomainItemRead } from './journal-sql-item-reads'

import { runJournalTransaction } from './database/journal-database'
import {
  insertJournalDomainImportPage,
  finishJournalDomainImport
} from './journal-domain-import-rows'
import { applyJournalDomainItem } from './journal-domain-item'
import { applyJournalDomainSubmission } from './journal-domain-submission-admission'
import { applyJournalDomainDispatch } from './journal-domain-dispatch'
import { applyJournalDomainCommandTurn } from './journal-domain-command-turn'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

const target = { sessionId: 'chat', epoch: 'epoch' }
const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function chat() {
  const db = new Database(':memory:')
  databases.push(db)
  migrateJournalDomainSchema(db)
  db.prepare(
    `INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence) VALUES('workspace',?,?,900,1)`
  ).run(target.sessionId, target.epoch)
  // Stored ordinal is admission order; sequence is the item's current render placement.
  const seed = (
    item: AgentJournalRenderItem,
    placement: { ordinal?: number; hidden?: boolean } = {}
  ) => {
    const ordinal = placement.ordinal ?? item.sequence
    runJournalTransaction(db, () =>
      writeJournalDomainCurrentItem(db, target, {
        item,
        ordinal,
        hidden: placement.hidden ?? false,
        ownerFence: 1
      })
    )
  }
  const alias = (providerItemId: string, itemId: string) =>
    db
      .prepare(
        'INSERT INTO journal_item_aliases(session_id,epoch,provider_item_id,item_id) VALUES(?,?,?,?)'
      )
      .run(target.sessionId, target.epoch, providerItemId, itemId)
  const tombstone = (itemId: string, turnId: string | null = null) => {
    db.prepare(
      'INSERT INTO journal_item_tombstones(session_id,epoch,item_id,revision) VALUES(?,?,?,9)'
    ).run(target.sessionId, target.epoch, itemId)
    if (turnId !== null) {
      db.prepare('INSERT INTO journal_removed_turns(session_id,epoch,turn_id) VALUES(?,?,?)').run(
        target.sessionId,
        target.epoch,
        turnId
      )
    }
  }
  const send = (submission: AgentJournalSubmission, ordinal: number) =>
    db
      .prepare(`INSERT INTO journal_submission_attempts(session_id,epoch,message_id,attempt_sequence,attempt_index,
      current,item_id,ordinal,submitted_at,accepted_sequence,fingerprint,dispatch_state,payload_json)
      VALUES(?,?,?,1,0,1,?,?,?,?,?,?,?)`)
      .run(
        target.sessionId,
        target.epoch,
        submission.clientMessageId,
        `orca:${submission.clientMessageId}`,
        ordinal,
        submission.submittedAt,
        submission.acceptedSequence ?? null,
        submission.clientMessageId,
        submission.dispatchState,
        JSON.stringify(submission)
      )
  const read = <K extends JournalDomainItemRead['kind']>(
    operation: Extract<JournalDomainItemRead, { kind: K }>
  ) => {
    const result = readJournalDomainItems(db, target, operation)
    if (result.kind !== operation.kind) {
      throw new Error('item read answered a different operation')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the checked discriminant matches the requested kind; TypeScript cannot narrow a generic union.
    return result as Extract<typeof result, { kind: K }>
  }
  return { db, seed, alias, tombstone, send, read }
}

function row(
  itemId: string,
  sequence: number,
  body: AgentJournalItemBody,
  extra: Partial<AgentJournalRenderItem> = {}
): AgentJournalRenderItem {
  return { itemId, revision: 1, sequence, observedAt: sequence, body, ...extra }
}
const user = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})
const turn = (
  turnId: string,
  state: 'running' | 'completed',
  extra: Partial<Extract<AgentJournalItemBody, { kind: 'turn' }>> = {}
): AgentJournalItemBody => ({ kind: 'turn', turnId, state, ...extra })
const clear: AgentJournalItemBody = {
  kind: 'status',
  text: 'Cleared',
  contextClear: { operationId: 'clear', afterFence: 1, clearedAt: 1 }
}
const window = (tokens: number) => ({ window: { tokens, capturedAt: tokens } })

it('resolves aliases and openers and presents hidden or removed rows as removed', () => {
  const { seed, alias, tombstone, read } = chat()
  seed(row('orca:send', 5, user('hello')))
  alias('provider:send', 'orca:send')
  seed(row('turn-a', 6, turn('t-a', 'completed', { userItemId: 'provider:send' })))
  seed(row('turn-b', 4, turn('t-b', 'completed', { userItemId: 'orca:send' })), { ordinal: 7 })
  seed(row('orca:rejected', 8, user('no')), { hidden: true })
  tombstone('gone')

  expect(read({ kind: 'canonical-item-ids', itemIds: ['provider:send', 'x'] }).items).toEqual([
    { itemId: 'provider:send', canonicalItemId: 'orca:send' },
    { itemId: 'x', canonicalItemId: 'x' }
  ])
  const history = read({
    kind: 'history-items',
    itemIds: ['provider:send', 'orca:rejected', 'gone'],
    options: { includeOpeners: true }
  }).items
  expect(
    history.map(({ key, canonicalItemId, removed, openedTurnIds }) => ({
      key,
      canonicalItemId,
      removed,
      openedTurnIds
    }))
  ).toEqual([
    {
      key: 'provider:send',
      canonicalItemId: 'orca:send',
      removed: false,
      openedTurnIds: ['turn-a', 'turn-b']
    },
    {
      key: 'orca:rejected',
      canonicalItemId: 'orca:rejected',
      removed: true,
      openedTurnIds: undefined
    },
    { key: 'gone', canonicalItemId: 'gone', removed: true, openedTurnIds: undefined },
    { key: 'orca:send', canonicalItemId: 'orca:send', removed: false, openedTurnIds: undefined },
    { key: 'turn-a', canonicalItemId: 'turn-a', removed: false, openedTurnIds: undefined },
    { key: 'turn-b', canonicalItemId: 'turn-b', removed: false, openedTurnIds: undefined }
  ])
  expect(history.find((entry) => entry.key === 'orca:rejected')?.item).toBeNull()
})

it('reads the newest turn, its clear boundary and named turns by current placement', () => {
  const { seed, tombstone, read } = chat()
  seed(row('old-turn', 1, turn('t-old', 'completed', { contextUsage: window(10) })))
  seed(row('clear', 2, clear))
  seed(row('used-turn', 3, turn('t-used', 'completed', { contextUsage: window(30) })))
  // Admitted first but moved to the newest placement: placement decides, admission breaks ties.
  seed(row('moved', 9, turn('t-moved', 'running')), { ordinal: 1 })
  seed(row('tied-early', 9, turn('t-tied', 'completed')), { ordinal: 0 })
  seed(row('orca:ask', 4, user('go')))
  tombstone('removed-turn', 't-removed')

  expect(read({ kind: 'running-turn' }).running).toEqual({
    item: expect.objectContaining({ itemId: 'moved' }),
    turnId: 't-moved'
  })
  // The input order's newest turn breaks the same placement tie by item ID instead.
  expect(read({ kind: 'message-options', clientMessageId: 'ask' }).options).toEqual({
    ordinaryMessage: true,
    runningTurn: false
  })
  expect(read({ kind: 'context-usage' }).usage).toEqual(window(30))
  expect(read({ kind: 'context-floor' }).floor).toEqual({ epoch: 'epoch', sequence: 2 })
  expect(read({ kind: 'named-turn', turnId: 't-moved' }).turn).toEqual({
    scope: { kind: 'turn', turnItemId: 'moved' },
    removed: false
  })
  expect(read({ kind: 'named-turn', turnId: 't-removed' }).turn).toEqual({
    scope: null,
    removed: true
  })
})

it('selects producer identities and the roster from scalars, skipping hidden rows', () => {
  const { seed, read } = chat()
  const agentRow = (
    itemId: string,
    sequence: number,
    agentId: string,
    ref: string,
    attempt?: number
  ) =>
    row(
      itemId,
      sequence,
      { kind: 'message', role: 'assistant', blocks: [] },
      {
        agentId,
        providerParentRef: ref,
        producerKind: 'agent',
        ...(attempt === undefined ? {} : { attempt })
      }
    )
  seed(agentRow('first', 1, 'agent-a', 'tool-1', 2))
  // The later-admitted alias wins even when it renders earlier.
  seed(agentRow('second', 0, 'agent-b', 'tool-1'), { ordinal: 5 })
  seed(agentRow('hidden', 3, 'agent-c', 'tool-2', 7), { hidden: true })
  const naming = (itemId: string, sequence: number, id: string) =>
    row(itemId, sequence, {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'subagent', id, label: id, state: 'working', groupId: 'g' }]
    })
  seed(naming('names-a', 6, 'agent-a'))
  seed(naming('names-c', 7, 'agent-c'), { hidden: true })

  const snapshot = read({ kind: 'claude-snapshot' }).snapshot
  expect(new Map(snapshot.canonicalByToolUse)).toEqual(new Map([['tool-1', 'agent-b']]))
  expect(new Map(snapshot.attemptByAgent)).toEqual(
    new Map([
      ['agent-a', 2],
      ['agent-b', 1]
    ])
  )
  expect(snapshot.subagents).toEqual(['agent-a'])
})

it('exports visible rows and sends after the newest clear across bounded query pages', () => {
  const { seed, send, read } = chat()
  const submission = (
    id: string,
    submittedAt: number,
    acceptedSequence?: number
  ): AgentJournalSubmission => ({
    clientMessageId: id,
    fence: 1,
    payloadFingerprint: id,
    dispatchState: acceptedSequence === undefined ? 'pending' : 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt,
    resolvedAt: null,
    ...(acceptedSequence === undefined ? {} : { acceptedSequence })
  })
  seed(row('orca:before', 1, user('before')))
  send(submission('before', 1, 1), 1)
  send(submission('pending', 2), 2)
  seed(row('clear', 3, clear))
  const tail = Array.from({ length: 300 }, (_, index) => `tail-${index}`)
  tail.forEach((id, index) => seed(row(id, 4 + index, user(id))))
  seed(row('orca:after', 400, user('after')))
  send(submission('after', 3, 400), 3)
  seed(row('orca:rejected', 401, user('rejected')), { hidden: true })
  send(submission('rejected', 4, 401), 4)

  const context = read({ kind: 'continuation-context' }).context
  expect(context.cursor).toEqual({ epoch: 'epoch', sequence: 900 })
  expect(context.items.map((item) => item.itemId)).toEqual([...tail, 'orca:after'])
  expect(context.submissions.map((entry) => entry.clientMessageId)).toEqual(['after', 'rejected'])
})

it('visits every item after a grouped import, placement revisions and command rejection', () => {
  const { db, read } = chat()
  db.prepare('DELETE FROM journal_chat_state').run()
  runJournalTransaction(db, () => {
    insertJournalDomainImportPage(db, target, {
      kind: 'items',
      rows: Array.from({ length: 200 }, (_, index) => ({
        ordinal: index + 1,
        ownerFence: 1,
        executionOwner: null,
        hidden: index === 199,
        item: row(`imported-${index}`, 2, user(`imported-${index}`), { sequenceIndex: index }),
        turnItemId: null,
        originalStopNoteJson: null,
        queueCommandTurn: false,
        queueFailedOutcome: false,
        queueFailedAt: 0,
        queueFailureWitnessedThrough: 0,
        queueFailureReportTurnItemId: null
      }))
    })
    finishJournalDomainImport(db, {
      ...target,
      workspaceId: 'workspace',
      head: {
        lastSequence: 2,
        highestFence: 1,
        contextBoundary: 0,
        lastActivityAt: 0,
        derivedTurnItemId: null,
        historyOrigin: null,
        queueFailureBoundary: 0,
        queuePauseMarks: { latestStop: null, resumedSequence: 0, reopenedSequence: 0 }
      }
    })
    const options = { fence: 1, turnScope: { kind: 'thread' as const } }
    applyJournalDomainItem(
      db,
      target,
      {
        kind: 'item',
        identity: { provider: 'orca', clientMessageId: 'new' },
        body: user('new'),
        options
      },
      10
    )
    applyJournalDomainSubmission(
      db,
      '/unused',
      target,
      {
        kind: 'submission',
        input: {
          clientMessageId: 'admitted',
          body: { ...user('admitted'), command: { name: 'compact' } },
          payloadFingerprint: 'admitted',
          fence: 1,
          handoverRecorded: true
        }
      },
      {
        identity: {
          sessionId: 'chat',
          workspaceId: 'workspace',
          hostId: 'host',
          agent: 'codex',
          providerHandle: codexProviderHandle('thread')
        }
      },
      11
    )
    applyJournalDomainItem(
      db,
      target,
      {
        kind: 'item',
        identity: { provider: 'orca', clientMessageId: 'new' },
        body: user('revised'),
        options
      },
      12
    )
    applyJournalDomainDispatch(
      db,
      target,
      {
        kind: 'dispatch',
        input: {
          clientMessageId: 'admitted',
          fence: 1,
          state: 'pending',
          turnScope: { kind: 'thread' }
        }
      },
      13
    )
    applyJournalDomainCommandTurn(
      db,
      target,
      {
        kind: 'command-open',
        input: {
          clientMessageId: 'admitted',
          fence: 1,
          turnScope: { kind: 'thread' },
          submittedAt: 11
        }
      },
      14
    )
    applyJournalDomainCommandTurn(
      db,
      target,
      {
        kind: 'command-settle',
        input: {
          dispatch: {
            clientMessageId: 'admitted',
            state: 'rejected',
            fence: 1,
            ...agentSessionFailureWords({ kind: 'notSignedIn' }, { surface: 'rejection' })
          },
          failureBody: { kind: 'status', text: 'Command failed', tone: 'error' }
        }
      },
      15
    )
  })
  expect(
    db
      .prepare(`SELECT item_id,ordinal FROM journal_items WHERE ordinal>=200 ORDER BY ordinal`)
      .all()
  ).toEqual([
    { item_id: 'imported-199', ordinal: 200 },
    { item_id: 'orca:new', ordinal: 201 },
    { item_id: 'orca:admitted', ordinal: 202 },
    { item_id: 'orca:command-turn%3Aadmitted', ordinal: 203 },
    { item_id: 'orca:command-result%3Aadmitted', ordinal: 204 }
  ])
  const seen: string[] = []
  let afterOrdinal = -1
  for (;;) {
    const page = read({
      kind: 'items-by-kind',
      kinds: ['message', 'status'],
      afterOrdinal,
      limit: 1
    })
    seen.push(...page.items.map((item) => item.itemId))
    if (page.nextOrdinal === null) {
      break
    }
    afterOrdinal = page.nextOrdinal
  }
  expect(seen).toEqual([
    ...Array.from({ length: 199 }, (_, index) => `imported-${index}`),
    'orca:new',
    'orca:admitted',
    'orca:command-result%3Aadmitted'
  ])
})
