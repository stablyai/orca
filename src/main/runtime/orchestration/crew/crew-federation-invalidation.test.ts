import { expect, it, vi } from 'vitest'
import { emptyCrew, type OrchestrationCrewSnapshot } from '../../../../shared/orchestration-crew'
import { ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION } from '../../../../shared/protocol-version'
import { CrewReadModel } from './crew-read-model'
import { fixture } from './crew-read-model.test-fixture'
import { meterCrewSql, sqlTotals } from './crew-recipient-sql.test-fixture'
import { subscribeCrew } from './crew-stream'

type RelayItem = Parameters<ReturnType<typeof fixture>['db']['importFederatedRelayItem']>[0]

function federationFixture(readers: number) {
  const f = fixture()
  const started = f.db.createStartingWorkerDispatch({
    taskSpec: 'Remote crew worker',
    taskRunId: f.run.id,
    creator: { kind: 'terminal', handle: 'term_coord', paneKey: f.handles.get('term_coord') },
    maxDepth: 10,
    startOptions: {},
    federation: {
      environmentId: 'crew-remote',
      environmentName: 'remote',
      peerFingerprint: 'crew-peer',
      protocolVersion: ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION
    }
  })
  const dispatchId = started.dispatch.id
  f.db.reconcileFederatedWorkerStart({
    dispatchId,
    state: 'ready',
    stage: 'remote_input_accepted',
    worktreeId: 'repo::remote',
    terminalHandle: 'term_remote'
  })
  f.db.updateFederatedDispatchRuntimeEpoch(dispatchId, 'epoch-1')
  const relay = (
    sequence: number,
    type: RelayItem['message']['type'],
    body: string,
    lifecycle: RelayItem['lifecycle'] = { kind: 'none' }
  ): RelayItem => ({
    dispatchId,
    sequence,
    message: {
      id: `relay-crew-${sequence}`,
      runId: f.run.id,
      from: `dispatch:${dispatchId}`,
      to: `run:${f.run.id}`,
      subject: 'Remote update',
      body,
      type,
      priority: 'normal'
    },
    lifecycle
  })
  f.db.insertMessage(relay(0, 'status', 'Initial remote update').message)
  const addresses = ['term_coord']
  for (let index = 1; index < readers; index++) {
    const handle = `term_observer_${index}`
    f.handles.set(handle, `tab_observer_${index}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`)
    addresses.push(handle)
    f.db.insertMessage({ from: 'term_peer', to: handle, subject: 'Peer', body: `Warm ${handle}` })
  }
  const acquire = vi.fn(() => f.deps)
  const model = new CrewReadModel(acquire, f.db.crewChanges.subscribe)
  const meter = meterCrewSql(f.db.db)
  const snapshots = new Map<string, OrchestrationCrewSnapshot>()
  const read = vi.fn((address: string) => {
    meter.control.phase = `reader:${address}`
    return model.read(address)
  })
  let publications = 0
  const stops = addresses.map((address) => {
    let pending = emptyCrew('unknown')
    return subscribeCrew(
      () => read(address),
      model.subscribe,
      (frame) => {
        if (frame.type === 'begin') {
          pending = emptyCrew(frame.status)
        } else if (frame.type === 'rows') {
          pending.sections[frame.section].push(...frame.rows)
        } else if (frame.type === 'complete') {
          publications++
          snapshots.set(address, pending)
        }
      }
    )
  })
  for (const address of addresses) {
    expect(snapshots.get(address)?.status).toBe('ok')
    expect(Object.values(snapshots.get(address)!.sections).flat().length).toBeGreaterThan(0)
  }
  return {
    ...f,
    dispatchId,
    taskId: started.task.id,
    relay,
    coordinator: () => snapshots.get('term_coord')!.sections.managing[0],
    async measure<T>(write: () => T) {
      read.mockClear()
      acquire.mockClear()
      publications = 0
      meter.executions.length = 0
      meter.control.phase = 'mutation'
      const result = write()
      await Promise.resolve()
      await Promise.resolve()
      return {
        result,
        snapshotReads: read.mock.calls.length,
        acquisitions: acquire.mock.calls.length,
        publications,
        mutationSql: sqlTotals(meter.executions.filter((entry) => entry.phase === 'mutation')),
        crewSql: sqlTotals(meter.executions.filter((entry) => entry.phase.startsWith('reader:'))),
        mailboxSql: addresses.map((address) => ({
          address,
          ...sqlTotals(meter.executions.filter((entry) => entry.phase === `reader:${address}`))
        }))
      }
    },
    stop() {
      stops.forEach((stop) => stop())
      meter.restore()
    }
  }
}

it.each([1, 10])(
  'does no crew work for federation metadata writes with %i warm readers',
  async (readers) => {
    const f = federationFixture(readers)
    try {
      const updates = [
        () => f.db.updateFederatedDispatchRuntimeEpoch(f.dispatchId, 'epoch-1'),
        () => f.db.updateFederatedDispatchRuntimeEpoch(f.dispatchId, 'epoch-2'),
        () =>
          f.db.updateFederatedDispatchResources({
            dispatchId: f.dispatchId,
            remoteRuntimeEpoch: 'epoch-2',
            worktreeId: 'repo::replacement',
            terminalHandle: 'term_remote_replacement'
          })
      ]
      for (const update of updates) {
        const measured = await f.measure(update)
        expect(measured.mutationSql.run).toBeGreaterThan(0)
        expect.soft(measured).toMatchObject({
          snapshotReads: 0,
          acquisitions: 0,
          publications: 0,
          crewSql: { all: 0, get: 0, iterate: 0 }
        })
      }
      expect(f.coordinator().latest?.preview).toBe('Initial remote update')
    } finally {
      f.stop()
    }
  }
)

it.each([1, 10])(
  'does no crew work for imported heartbeats or their replay with %i warm readers',
  async (readers) => {
    const f = federationFixture(readers)
    try {
      const heartbeat = f.relay(1, 'heartbeat', '', {
        kind: 'heartbeat',
        at: '2026-11-02T12:00:00.000Z'
      })
      for (const duplicate of [false, true]) {
        const measured = await f.measure(() => f.db.importFederatedRelayItem(heartbeat))
        expect(measured.result.duplicate).toBe(duplicate)
        expect(measured.mutationSql.get).toBeGreaterThan(0)
        expect.soft(measured).toMatchObject({
          snapshotReads: 0,
          acquisitions: 0,
          publications: 0,
          crewSql: { all: 0, get: 0, iterate: 0 }
        })
      }
      expect(f.coordinator().latest?.preview).toBe('Initial remote update')
    } finally {
      f.stop()
    }
  }
)

it('scopes relayed status to its warm mailbox while preserving imported questions and worker completion', async () => {
  const f = federationFixture(10)
  try {
    const status = await f.measure(() =>
      f.db.importFederatedRelayItem(f.relay(1, 'status', 'Remote checkpoint'))
    )
    expect(f.coordinator().latest?.preview).toBe('Remote checkpoint')
    expect.soft(status).toMatchObject({
      snapshotReads: 10,
      acquisitions: 0,
      publications: 1,
      crewSql: { all: 2, get: 0 }
    })
    expect.soft(status.mailboxSql[0]).toMatchObject({ address: 'term_coord', all: 2, get: 0 })
    expect
      .soft(status.mailboxSql.slice(1).every((sql) => sql.all === 0 && sql.get === 0))
      .toBe(true)
    await f.measure(() =>
      f.db.importFederatedRelayItem(f.relay(2, 'question', 'Which remote option?'))
    )
    expect(f.coordinator().pendingQuestion?.preview).toBe('Which remote option?')
    const completed = await f.measure(() =>
      f.db.importFederatedRelayItem(
        f.relay(3, 'worker_done', 'Completed remotely', {
          kind: 'worker_report',
          taskId: f.taskId,
          outcome: 'succeeded',
          result: 'Completed remotely'
        })
      )
    )
    expect(completed.result.lifecycle).toMatchObject({ action: 'settled', outcome: 'succeeded' })
    expect(completed.acquisitions).toBe(1)
    expect(f.coordinator().task?.state).toBe('completed')
    expect(f.coordinator().pendingQuestion).toBeUndefined()
  } finally {
    f.stop()
  }
})
