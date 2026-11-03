import { expect, it, vi } from 'vitest'
import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import { emptyCrew, type OrchestrationCrewSnapshot } from '../../../../shared/orchestration-crew'
import { formatOrcaSessionAddress } from '../../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { CrewReadModel } from './crew-read-model'
import { fixture } from './crew-read-model.test-fixture'
import { subscribeCrew } from './crew-stream'

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

function mounted(model: CrewReadModel, addresses: string[]) {
  const snapshots = new Map<string, OrchestrationCrewSnapshot>()
  const stops = addresses.map((address) => {
    let pending = emptyCrew('unknown')
    return subscribeCrew(
      () => model.read(address),
      model.subscribe,
      (frame) => {
        if (frame.type === 'begin') {
          pending = emptyCrew(frame.status)
        } else if (frame.type === 'rows') {
          pending.sections[frame.section].push(...frame.rows)
        } else if (frame.type === 'complete') {
          snapshots.set(address, pending)
        }
      }
    )
  })
  return {
    stop: () => stops.forEach((stop) => stop()),
    rows: (address: string) => Object.values(snapshots.get(address)!.sections).flat()
  }
}

it.each(['before', 'after'] as const)(
  'keeps broad traffic invalidation when it arrives %s multiple scoped inserts in one flush',
  async (order) => {
    const f = fixture()
    const send = (to: string, body: string) =>
      f.db.insertMessage({
        runId: f.run.id,
        from: 'term_worker',
        to,
        subject: 'Update',
        body
      })
    for (const address of ['term_coord', 'term_helper']) {
      send(address, `Original ${address}`)
    }
    const broadMessage = send('term_outbound', 'Original broad update')
    const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
    const stream = mounted(model, ['term_coord', 'term_helper', 'term_outbound'])
    try {
      // Simulate a writer that has only broad evidence, alongside ordinary scoped inserts.
      f.db.db
        .prepare('UPDATE messages SET body = ? WHERE id = ?')
        .run('Changed by broad writer', broadMessage.id)
      const broad = () => f.db.crewChanges.notify(new Set(['traffic']))
      if (order === 'before') {
        broad()
      }
      send('term_coord', 'Changed coordinator')
      send('term_helper', 'Changed helper')
      if (order === 'after') {
        broad()
      }
      await flush()
      for (const [address, preview] of [
        ['term_coord', 'Changed coordinator'],
        ['term_helper', 'Changed helper'],
        ['term_outbound', 'Changed by broad writer']
      ]) {
        expect(stream.rows(address).some((row) => row.latest?.preview === preview)).toBe(true)
      }
    } finally {
      stream.stop()
    }
  }
)

it('keeps unrelated warm mailbox consumers SQL-free after an ordinary scoped insertion', async () => {
  const f = fixture()
  for (const to of ['term_coord', 'term_helper']) {
    f.db.insertMessage({ from: 'term_worker', to, subject: 'Warm mailbox', body: to })
  }
  const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
  const stream = mounted(model, ['term_coord', 'term_helper'])
  const prepare = vi.spyOn(f.db.db, 'prepare')
  try {
    f.db.insertMessage({
      from: 'term_peer',
      to: 'term_outbound',
      subject: 'Unrelated mailbox',
      body: 'Leave warm consumers alone'
    })
    prepare.mockClear()
    await flush()
    expect(prepare).not.toHaveBeenCalled()
    for (const address of ['term_coord', 'term_helper']) {
      expect(stream.rows(address).some((row) => row.latest?.preview === address)).toBe(true)
    }
  } finally {
    prepare.mockRestore()
    stream.stop()
  }
})

it('invalidates the current coordinator alias using returned persisted routing endpoints', async () => {
  const f = fixture()
  f.db.bindRun({
    runId: f.run.id,
    coordinatorHandle: 'term_helper',
    coordinatorPaneKey: f.handles.get('term_helper')!
  })
  const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
  const stream = mounted(model, ['term_helper'])
  try {
    const message = f.db.insertMessage({
      runId: f.run.id,
      from: 'term_peer',
      to: 'term_coord',
      subject: 'Remembered coordinator',
      body: 'Delivered to the current coordinator'
    })
    expect(message.to_handle).toBe(`run:${f.run.id}`)
    await flush()
    expect(stream.rows('term_helper').some((row) => row.latest?.preview === message.body)).toBe(
      true
    )
  } finally {
    stream.stop()
  }
})

it('applies a targeted rename coalesced with topology without rereading all records, then reacquires on records changes', async () => {
  const f = fixture()
  const id = testOrcaSessionId('crew-combined-rename')
  const address = formatOrcaSessionAddress(id)
  const record = (conversationName: string) =>
    agentSessionConversationView(agentSessionRecordFixture({ sessionId: id, conversationName }))
  const records = new Map([[id, record('Original native name')]])
  const listRecords = vi.fn(() => [...records.values()])
  f.deps.records = {
    listRecords,
    getRecord: (sessionId) =>
      [...records.values()].find((row) => row.sessionId === sessionId) ?? null
  }
  f.deps.name = (party, task, captured) =>
    (party.orcaSessionId && captured?.getRecord(party.orcaSessionId)?.conversationName) ?? task
  f.assign(address)
  const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
  const stream = mounted(model, ['term_coord'])
  try {
    expect(stream.rows('term_coord').map((row) => row.label)).toContain('Original native name')
    expect(listRecords).toHaveBeenCalledTimes(1)
    records.set(id, record('Renamed with topology'))
    f.db.crewChanges.notify(new Set(['topology']))
    f.db.crewChanges.notify(Object.assign(new Set(['names'] as const), { recordIds: [id] }))
    await flush()
    expect(stream.rows('term_coord').map((row) => row.label)).toContain('Renamed with topology')
    expect(listRecords).toHaveBeenCalledTimes(1)
    records.set(id, record('New complete record view'))
    f.db.crewChanges.notify(new Set(['records']))
    await flush()
    expect(stream.rows('term_coord').map((row) => row.label)).toContain('New complete record view')
    expect(listRecords).toHaveBeenCalledTimes(2)
    f.deps.records = null
    f.db.crewChanges.notify(new Set(['topology', 'records']))
    await flush()
    expect(stream.rows('term_coord').map((row) => row.label)).not.toContain(
      'New complete record view'
    )
    f.deps.records = {
      listRecords,
      getRecord: (sessionId) =>
        [...records.values()].find((row) => row.sessionId === sessionId) ?? null
    }
    records.set(id, record('Reopened source view'))
    f.db.crewChanges.notify(new Set(['topology', 'records']))
    await flush()
    expect(stream.rows('term_coord').map((row) => row.label)).toContain('Reopened source view')
    expect(listRecords).toHaveBeenCalledTimes(3)
  } finally {
    stream.stop()
  }
})
