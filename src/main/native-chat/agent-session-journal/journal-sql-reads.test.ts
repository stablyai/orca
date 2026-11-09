import type { JournalWorkAuthority } from './journal-observer-read'
import { expect, it } from 'vitest'
import {
  appendItems,
  body,
  fixture,
  item
} from '../agent-session-wire/publication/history/testing/agent-session-history-contract.test-fixture'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

it('reads filtered pages and derives interrupted work from captured ownership', async () => {
  await appendItems(300)
  const thread = { fence: 1, turnScope: { kind: 'thread' as const } }
  await fixture.journal.appendItem(
    { provider: 'orca', clientMessageId: 'turn-1' },
    { kind: 'turn', turnId: 'turn-1', state: 'running' },
    thread
  )
  await fixture.journal.appendItem(item(400), body('after the turn'), thread)
  await fixture.journal.appendItem(
    { provider: 'orca', clientMessageId: 'options-message' },
    body('message with controls'),
    thread
  )
  const sql = fixture.journal.reads
  expect(await sql.hasItems()).toBe(true)
  expect(await sql.namedTurn('turn-1')).toEqual({
    scope: { kind: 'turn', turnItemId: 'orca:turn-1' },
    removed: false
  })
  expect(await sql.namedTurn('missing-turn')).toEqual({ scope: null, removed: false })
  expect(await sql.messageOptions('options-message')).toEqual({
    ordinaryMessage: true,
    runningTurn: true
  })
  expect(await sql.messageOptions('turn-1')).toEqual({
    ordinaryMessage: false,
    runningTurn: true
  })
  expect(await sql.canonicalItemIds(['orca:turn-1', 'orca:missing'])).toEqual([
    { itemId: 'orca:turn-1', canonicalItemId: 'orca:turn-1' },
    { itemId: 'orca:missing', canonicalItemId: 'orca:missing' }
  ])
  const turns: AgentJournalRenderItem[] = []
  await sql.visitItems({ kinds: ['turn'] }, (_id, _sequence, _body, _linkage, item) => {
    turns.push(item)
  })
  expect(turns).toMatchObject([
    {
      itemId: 'orca:turn-1',
      revision: 1,
      sequence: 301,
      body: { kind: 'turn', turnId: 'turn-1', state: 'running' }
    }
  ])
  const visited: string[] = []
  await sql.visitItems({ kinds: ['message'] }, (itemId) => visited.push(itemId))
  expect(visited).toHaveLength(302)
  expect(new Set(visited).size).toBe(302)
  expect(visited[0]).toBe('codex:thread-1:turn-1:1')
  expect(visited[301]).toBe('orca:options-message')
  const authority: JournalWorkAuthority = {
    handle: 'this-open',
    record: {
      currentFence: 1,
      ownerObservation: { claimStatus: 'live', unreconciled: false, handoffStage: null }
    },
    child: { fence: 1, heldSends: [] },
    handingOver: [],
    continuingUnadmitted: [],
    finalizing: [],
    openedThrough: await sql.physicalCursor(),
    reopenFloor: null,
    operationalRevision: 0,
    stopRevision: 0,
    stop: null
  }
  const observed = await sql.observer({
    authority,
    start: 0,
    floor: 0,
    firstInputSubmissionKey: null
  })
  expect(observed.work).toMatchObject({
    liveFence: 1,
    working: true,
    activeTurn: { turnId: 'turn-1' }
  })
  expect(observed.state.summary).toMatchObject({ status: 'working' })
  const ended = await sql.observer({
    authority: {
      ...authority,
      ended: { fence: 1, rootGone: true, cause: 'exit' },
      operationalRevision: 1
    },
    start: 0,
    floor: 0,
    firstInputSubmissionKey: null
  })
  expect(ended.physicalCursor).toEqual(observed.physicalCursor)
  expect(ended.work).toMatchObject({
    liveFence: null,
    working: false,
    activeTurn: null,
    latestTurn: { itemId: 'orca:turn-1', turn: { state: 'interrupted' } }
  })
  expect(ended.state.summary).toMatchObject({ status: 'idle', turnOutcome: 'interruption' })
  expect(structuredClone(ended)).toEqual(ended)
})
