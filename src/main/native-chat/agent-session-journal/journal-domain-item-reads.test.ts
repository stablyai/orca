import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { journalDomainHistoryMetadata } from './journal-domain-history-metadata'
import { writeJournalDomainItemNames } from './journal-domain-item-names'
import { journalDomainItemReadColumns } from './journal-domain-item-read-columns'
import { readJournalDomainItems, type JournalDomainItemRead } from './journal-sql-item-reads'

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
    `INSERT INTO journal_chat_state(session_id,epoch,last_sequence,highest_fence) VALUES(?,?,900,1)`
  ).run(target.sessionId, target.epoch)
  // Stored ordinal is admission order; sequence is the item's current render placement.
  const seed = (
    item: AgentJournalRenderItem,
    placement: { ordinal?: number; hidden?: boolean } = {}
  ) => {
    const ordinal = placement.ordinal ?? item.sequence
    const payload = JSON.stringify(item)
    const metadata = journalDomainHistoryMetadata(item, payload)
    db.prepare(`INSERT INTO journal_items
      (session_id,epoch,item_id,ordinal,revision,sequence,sequence_index,owner_fence,payload_json,hidden,
       root,subagent_row,subagent_group_key,turn_marker,wire_bytes,
       kind,message_role,turn_id,opener_item_id,context_clear,goal_transition,
       producer_agent_id,producer_parent_ref,producer_attempt,prompt,signed_out)
      VALUES(?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      target.sessionId,
      target.epoch,
      item.itemId,
      ordinal,
      item.revision,
      item.sequence,
      item.sequenceIndex ?? 0,
      payload,
      Number(placement.hidden ?? false),
      metadata.root,
      metadata.subagentRow,
      metadata.subagentGroupKey,
      metadata.turnMarker,
      metadata.wireBytes,
      ...journalDomainItemReadColumns(item)
    )
    writeJournalDomainItemNames(
      db,
      target,
      item,
      { ordinal, hidden: placement.hidden ?? false },
      metadata.namedSubagentIds
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
const user = (text: string): AgentJournalItemBody => ({
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
