import { expect, it } from 'vitest'

import {
  emptyCrew,
  type OrchestrationCrewSnapshot
} from '../../../../shared/orchestration/orchestration-crew'

import type { CrewInvalidation } from './crew-changes'
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

it('announces a coordinator rebind once with every mailbox it changed, and a no-op not at all', () => {
  const f = fixture()
  const bind = (runId: string) =>
    f.db.bindRun({
      runId,
      coordinatorHandle: 'term_helper',
      coordinatorPaneKey: f.handles.get('term_helper')!
    })
  bind(f.run.id)
  const other = f.db.createRun({
    objective: 'second run',
    coordinatorHandle: null,
    coordinatorPaneKey: null
  })
  const notices: CrewInvalidation[] = []
  const stop = f.db.crewChanges.subscribe((facets) => notices.push(facets))
  try {
    bind(f.run.id)
    expect(notices).toEqual([])
    bind(other.id)
    // One notice, after commit, naming both Runs the rebind changed.
    expect(notices).toHaveLength(1)
    expect([...(notices[0].trafficAddresses ?? [])]).toEqual(
      expect.arrayContaining([`run:${f.run.id}`, `run:${other.id}`])
    )
  } finally {
    stop()
  }
})
