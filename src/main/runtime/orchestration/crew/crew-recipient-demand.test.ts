import '../../rpc/unused-default-rpc-methods.test-fixture'
import { expect, it } from 'vitest'
import type { OrchestrationCrewFrame } from '../../../../shared/orchestration-crew'
import { CrewReadModel } from './crew-read-model'
import { subscribeCrew } from './crew-stream'
import { resolveBareOrchestrationRecipient } from '../../rpc/methods/orchestration/messaging/recipient-routing'
import { OrcaRuntimeService } from '../../orca-runtime'
import { formatOrcaSessionAddress as address } from '../../../../shared/orca-session-address'
import {
  crewRecord,
  deltaFixture,
  remembered,
  SELF,
  TARGET
} from './crew-recipient-delta-cost.test-fixture'
import { meterCrewSql } from './crew-recipient-sql.test-fixture'

it('retries complete history after unknown in the same watched generation instead of caching fallback', () => {
  const f = deltaFixture()
  f.records.set(TARGET, crewRecord(TARGET))
  f.visible.add(TARGET)
  f.db.insertMessage({
    from: address(TARGET),
    to: address(SELF),
    subject: 'Peer',
    body: 'retained target'
  })
  remembered(f)
  const runtime = new OrcaRuntimeService()
  // The real command's history refusal precedes fallback, so no provider host is needed.
  const oracle = resolveBareOrchestrationRecipient({ runtime, db: f.db, handle: address(TARGET) })
  expect(oracle).toMatchObject({ ok: false, code: 'recipient_ambiguous' })
  const meter = meterCrewSql(f.db.db)
  const fault = new Error('actual history read failed')
  let failures = 1
  meter.control.before = (sql) => {
    if (sql.includes('coordinator.run_id FROM json_each') && failures-- > 0) {
      throw fault
    }
  }
  const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
  const frames: OrchestrationCrewFrame[] = []
  const caught: unknown[] = []
  const stop = subscribeCrew(
    () => {
      try {
        return model.read(address(SELF))
      } catch (error) {
        caught.push(error)
        throw error
      }
    },
    model.subscribe,
    (frame) => frames.push(frame)
  )
  try {
    expect(frames).toEqual([{ type: 'begin', status: 'unknown' }, { type: 'complete' }])
    expect(caught[0]).toBe(fault)
    meter.control.before = undefined
    const output = model.read(address(SELF))
    expect(output.sections.talkingWith).toHaveLength(1)
    expect(output.sections.talkingWith[0]).not.toHaveProperty('sendAddress')
  } finally {
    stop()
    meter.restore()
  }
})
