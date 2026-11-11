import { expect, it, vi } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import type { OrchestrationCoordinatorKey } from '../addressing/orchestration-caller-identity'
import { createCrewSourceInputs } from './crew-source-inputs'
import { fixture } from './crew-read-model.test-fixture'

it('rolls a cached peer winner over at the exact traffic boundary, recovers on backward time, and retains old pending attention', () => {
  const f = fixture()
  const worker = f.assign('term_worker')
  const at = Date.parse('2026-11-02T12:00:00.000Z')
  const insertAt = (body: string, createdAt: number) => {
    const message = f.db.insertMessage({
      runId: f.run.id,
      from: 'term_peer',
      to: 'term_coord',
      subject: 'Peer update',
      body
    })
    f.db.db
      .prepare('UPDATE messages SET created_at = ? WHERE id = ?')
      .run(new Date(createdAt).toISOString(), message.id)
    return message
  }
  const longerLived = insertAt('Earlier sequence, later timestamp', at + 10_000)
  const winner = insertAt('Later sequence, earlier timestamp', at)
  const pending = f.db.createQuestion({
    runId: f.run.id,
    dispatchId: worker.id,
    askerHandle: 'term_worker',
    to: 'term_coord',
    question: 'Old question still needs an answer'
  })
  f.db.db
    .prepare('UPDATE messages SET created_at = ? WHERE id = ?')
    .run(new Date(at - 3 * AGENT_STATUS_STALE_AFTER_MS).toISOString(), pending.message.id)
  const source = createCrewSourceInputs(f.db)
  const aliases = [`run:${f.run.id}`]
  const peer = (now: number) => source.traffic(aliases, now).find((row) => row.peer === 'term_peer')
  const boundary = at + AGENT_STATUS_STALE_AFTER_MS

  expect(peer(boundary - 1)?.sequence).toBe(winner.sequence)
  expect(peer(boundary)?.sequence).toBe(winner.sequence)
  expect(peer(boundary + 1)).toMatchObject({
    sequence: longerLived.sequence,
    body: longerLived.body
  })
  expect(source.traffic(aliases, boundary + 10_001)).toEqual([])
  expect(source.questions(aliases)).toMatchObject([
    { dispatch_id: worker.id, body: 'Old question still needs an answer' }
  ])
  expect(peer(boundary)?.sequence).toBe(winner.sequence)
  expect(f.db.getQuestion(pending.message.id)?.status).toBe('pending')
})

it('refreshes every overlapping alias mailbox while retaining unrelated reads, then supports broad invalidation', () => {
  const f = fixture()
  const worker = f.assign('term_worker')
  const runAddress = `run:${f.run.id}`
  const now = Date.parse('2026-11-02T12:00:00.000Z')
  const send = (to: string, body: string) => {
    const message = f.db.insertMessage({
      runId: f.run.id,
      from: 'term_worker',
      to,
      subject: 'Update',
      body
    })
    f.db.db
      .prepare('UPDATE messages SET created_at = ? WHERE id = ?')
      .run(new Date(now).toISOString(), message.id)
    return message
  }
  const ask = (to: string, question: string) =>
    f.db.createQuestion({
      runId: f.run.id,
      dispatchId: worker.id,
      askerHandle: 'term_worker',
      to,
      question
    })
  send('term_coord', 'Original coordinator update')
  send('term_peer', 'Original peer update')
  const source = createCrewSourceInputs(f.db)
  const selected = ['term_coord', runAddress]
  const overlapping = [runAddress]
  const unrelated = ['term_peer', 'term_helper']
  for (const aliases of [selected, overlapping, unrelated]) {
    source.traffic(aliases, now)
    source.questions(aliases)
  }
  send('term_coord', 'Changed coordinator update')
  send('term_peer', 'Changed peer update')
  ask('term_coord', 'New coordinator question')
  ask('term_peer', 'New peer question')
  source.invalidateTraffic(new Set([runAddress]))
  for (const aliases of [selected, overlapping]) {
    expect(
      source.traffic(aliases, now).some((row) => row.body === 'Changed coordinator update')
    ).toBe(true)
    expect(source.questions(aliases).map((row) => row.body)).toEqual(['New coordinator question'])
  }
  const prepare = vi.spyOn(f.db.db, 'prepare')
  try {
    expect(source.traffic(unrelated.toReversed(), now).map((row) => row.body)).toEqual([
      'Original peer update'
    ])
    expect(source.questions(unrelated)).toEqual([])
    expect(prepare).not.toHaveBeenCalled()
  } finally {
    prepare.mockRestore()
  }
  source.invalidateTraffic()
  expect(source.traffic(unrelated, now).some((row) => row.body === 'Changed peer update')).toBe(
    true
  )
  expect(source.questions(unrelated).map((row) => row.body)).toEqual(['New peer question'])
  expect(source.questions(selected).map((row) => row.body)).toEqual(['New coordinator question'])
})

it('keeps owned Run facts distinct when a coordinator shares only a handle, pane, or session', () => {
  const f = fixture()
  const sessionA = testOrcaSessionId('owned-cache-a')
  const sessionB = testOrcaSessionId('owned-cache-b')
  const workerRun = f.db.createRun({
    objective: 'Other remembered handle',
    coordinatorHandle: 'term_worker',
    coordinatorPaneKey: f.handles.get('term_worker')!
  })
  const peerRun = f.db.createRun({
    objective: 'Other pane',
    coordinatorHandle: 'term_peer',
    coordinatorPaneKey: f.handles.get('term_peer')!
  })
  const sessionRuns = [sessionA, sessionB].map((session) =>
    f.db.createRun({
      objective: 'Native owner',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: session
    })
  )
  const base: OrchestrationCoordinatorKey = {
    terminalHandle: 'term_coord',
    paneKey: f.handles.get('term_coord')!,
    orcaSessionId: sessionA
  }
  const cases: { party: OrchestrationCoordinatorKey; ids: string[] }[] = [
    { party: base, ids: [f.run.id, sessionRuns[0].id] },
    {
      party: { ...base, terminalHandle: 'term_worker' },
      ids: [f.run.id, workerRun.id, sessionRuns[0].id]
    },
    {
      party: { ...base, paneKey: f.handles.get('term_peer')! },
      ids: [f.run.id, peerRun.id, sessionRuns[0].id]
    },
    { party: { ...base, orcaSessionId: sessionB }, ids: [f.run.id, sessionRuns[1].id] }
  ]
  const source = createCrewSourceInputs(f.db)
  for (const { party, ids } of cases) {
    expect(source.ownedRuns(party).sort()).toEqual(ids.map((id) => `run:${id}`).sort())
  }
  const bound = vi.spyOn(f.db, 'runsBoundToCoordinator')
  try {
    for (const { party, ids } of cases.toReversed()) {
      expect(source.ownedRuns(party).sort()).toEqual(ids.map((id) => `run:${id}`).sort())
    }
    expect(bound).not.toHaveBeenCalled()
  } finally {
    bound.mockRestore()
  }
})
