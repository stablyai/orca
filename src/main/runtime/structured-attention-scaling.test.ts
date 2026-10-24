import { expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { StructuredAgentSessionTurnCompletionFeed } from '../native-chat/agent-session-wire/structured-agent-session-turn-completion-feed'
import {
  structuredAttentionScaling,
  assertSnapshotCosts
} from './structured-attention-scaling.test-fixture'

it.each([
  [256, 128, 2],
  [2560, 128, 2],
  [2560, 1280, 2],
  [256, 128, 20]
])('bounds real journal publication at I=%i S=%i U=%i', async (items, submissions, subscribers) => {
  const flow = await structuredAttentionScaling({ items, submissions, subscribers })
  try {
    const operation = await flow.send('Desktop request')
    flow.reset()
    await flow.writeTurn('measured', operation, 'running')
    expect(flow.starts()).toBe(subscribers)
    const rootCosts = flow.snapshots.filter((cost) => cost.phase === 'new-root')
    expect(rootCosts).toHaveLength(1)
    expect(rootCosts[0]).toMatchObject({ items: items + 1, submissions })
    assertSnapshotCosts(rootCosts)
    flow.reset()
    const rootId = agentJournalItemKey({
      provider: 'codex',
      threadId: THREAD,
      turnId: 'measured',
      ordinal: 0
    })
    let revision = flow.journal.item(rootId)!.revision
    let cursor = flow.journal.cursor()
    const publications = vi
      .spyOn(StructuredAgentSessionTurnCompletionFeed.prototype, 'observe')
      .mockClear()
    const sameRootUpdates: { revision: number; sequence: number }[] = []
    for (let index = 0; index < 2; index += 1) {
      await flow.writeTurn('measured', operation, 'running')
      const accepted = flow.journal.item(rootId)!
      const next = flow.journal.cursor()
      expect(accepted).toMatchObject({
        itemId: rootId,
        body: { kind: 'turn', turnId: 'measured', state: 'running' }
      })
      expect(accepted.revision).toBeGreaterThan(revision)
      expect(next.epoch).toBe(cursor.epoch)
      expect(next.sequence).toBeGreaterThan(cursor.sequence)
      expect(publications).toHaveBeenCalledTimes(index + 1)
      expect(publications).toHaveBeenLastCalledWith(SESSION, flow.journal)
      sameRootUpdates.push({ revision: accepted.revision, sequence: next.sequence })
      revision = accepted.revision
      cursor = next
    }
    expect(flow.starts()).toBe(0)
    expect(flow.snapshots.filter((cost) => cost.phase === 'new-root')).toEqual([])
    await flow.writeTurn('measured', operation, 'completed')
    expect(flow.provenance).toEqual([
      { caller: 'client-1', snapshots: 1, candidates: 1, filters: 1 }
    ])
    expect(flow.tail.events.filter((event) => event.type === 'notification')).toHaveLength(0)
    expect(flow.proof).toEqual([{ result: true, filter: 8, membership: 16 }])
    await flow.prompt(0, 'measured')
    expect(flow.provenance).toHaveLength(2)
    expect(flow.provenance.at(-1)).toEqual({
      caller: 'client-1',
      snapshots: 1,
      candidates: 1,
      filters: 1
    })
    assertSnapshotCosts(flow.snapshots.filter((cost) => cost.phase === 'provenance'))
    console.info('host-history-scaling', {
      items,
      submissions,
      subscribers,
      rootCosts,
      sameRootUpdates,
      attribution: flow.snapshots.filter((cost) => cost.phase === 'provenance')
    })
  } finally {
    await flow.close()
  }
})

it.each([2, 20])(
  'filters C=%i real receipt candidates and sends ambiguous/unknown origins',
  async (candidates) => {
    const flow = await structuredAttentionScaling()
    try {
      const operation = await flow.send('Candidate proof')
      for (let index = 1; index < candidates; index += 1) {
        flow.addCandidate(operation, `other-${index}`, false)
      }
      await flow.writeTurn('candidate', operation, 'running')
      flow.reset()
      await flow.writeTurn('candidate', operation, 'completed')
      expect(flow.provenance).toEqual([
        { caller: 'client-1', snapshots: 1, candidates: 1, filters: candidates }
      ])
      expect(flow.proof).toHaveLength(1)
      expect(flow.tail.events.filter((event) => event.type === 'notification')).toHaveLength(0)
      flow.addCandidate(operation, 'ambiguous', true)
      await flow.prompt(0, 'candidate')
      expect(flow.provenance.at(-1)).toEqual({
        caller: null,
        snapshots: 1,
        candidates: 1,
        filters: candidates + 1
      })
      expect(flow.tail.events.filter((event) => event.type === 'notification')).toHaveLength(1)
      await flow.prompt(0, 'candidate', true)
      const beforeUnknown = flow.provenance.length
      await flow.writeTurn('unknown', 'not-a-submission', 'running')
      await flow.writeTurn('unknown', 'not-a-submission', 'completed')
      expect(flow.provenance).toHaveLength(beforeUnknown + 1)
      expect(flow.provenance.at(-1)).toMatchObject({ caller: null, snapshots: 1, candidates: 0 })
      expect(flow.tail.events.filter((event) => event.type === 'notification')).toHaveLength(2)
      console.info('host-candidate-scaling', { candidates, provenance: flow.provenance })
    } finally {
      await flow.close()
    }
  }
)

it.each([
  [8, 2],
  [80, 2],
  [8, 20]
])(
  'proves completion against D=%i authenticated sockets c=%i capabilities',
  async (sockets, capabilities) => {
    const flow = await structuredAttentionScaling({ sockets, capabilities })
    try {
      expect(flow.socket.wiring.connectionCount).toBe(sockets)
      const first = await flow.send('Connected request')
      await flow.writeTurn('connected', first, 'running')
      flow.reset()
      await flow.writeTurn('connected', first, 'completed')
      expect(flow.proof).toEqual([
        { result: true, filter: sockets, membership: sockets * capabilities }
      ])
      expect(flow.tail.events.filter((event) => event.type === 'notification')).toHaveLength(0)
      flow.socket.disconnect()
      expect(flow.socket.wiring.connectionCount).toBe(0)
      const second = await flow.send('Disconnected request')
      await flow.writeTurn('disconnected', second, 'running')
      await flow.writeTurn('disconnected', second, 'completed')
      expect(flow.proof.at(-1)?.result).toBe(false)
      expect(flow.tail.events.filter((event) => event.type === 'notification')).toHaveLength(1)
      console.info('socket-proof-scaling', { sockets, capabilities, proof: flow.proof })
    } finally {
      await flow.close()
    }
  }
)

it.each([
  [20, 2],
  [200, 2],
  [200, 20]
])(
  'retires structured replay R=%i K=%i exact alerts on a genuine later root',
  async (replay, count) => {
    const flow = await structuredAttentionScaling()
    try {
      flow.socket.disconnect()
      const first = await flow.send('Prompt-bearing root')
      await flow.writeTurn('prompt-root', first, 'running')
      for (let index = 0; index < replay - count; index += 1) {
        flow.controller.dispatch({
          type: 'notification',
          source: 'test',
          title: '',
          body: '',
          notificationId: `background-${index}`
        })
      }
      for (let index = 0; index < count; index += 1) {
        await flow.prompt(index, 'prompt-root')
      }
      const selected = flow.tail.events.filter(
        (event) => event.type === 'notification' && event.structuredOrigin
      )
      expect(selected).toHaveLength(count)
      expect(flow.controller.getMissedSince(0)).toHaveLength(replay)
      const next = await flow.send('Acceptance alone is not a start')
      const before = flow.tail.mark()
      flow.reset()
      await flow.writeTurn('later-root', next, 'running')
      expect(flow.retirements).toHaveLength(1)
      expect(flow.retirements[0]).toBeGreaterThan(0)
      expect(flow.retirements[0]).toBeLessThanOrEqual(3 * replay + 2 * count * replay)
      const tail = await flow.tail.assertRetired(before, selected)
      console.info('structured-retirement-scaling', {
        replay,
        count,
        operations: flow.retirements[0],
        tail
      })
    } finally {
      await flow.close()
    }
  }
)
