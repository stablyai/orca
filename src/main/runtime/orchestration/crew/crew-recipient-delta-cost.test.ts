import '../../rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { CrewReadModel } from './crew-read-model'
import { address, crewRecord, deltaFixture } from './crew-recipient-delta-cost.test-fixture'
import { meterCrewSql, selectedKeyMultiplier, sqlTotals } from './crew-recipient-sql.test-fixture'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'

it('charges independent peers on the whole trigger, covered reuse and equal topology reacquisition', () => {
  const samples = [3, 30].map((population) => {
    const f = deltaFixture()
    f.records.clear()
    f.visible.clear()
    for (let i = 0; i < population; i++) {
      const id = testOrcaSessionId(`chat-authority-${i}`)
      f.records.set(id, crewRecord(id))
      f.visible.add(id)
      f.db.insertMessage({
        id: `unknown-${i}`,
        from: address(id),
        to: 'term_worker',
        subject: 'Peer',
        body: `peer ${i}`
      })
    }
    const sourceRows = vi.spyOn(f.deps.records!, 'listRecords')
    const meter = meterCrewSql(f.db.db)
    const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
    const stop = model.subscribe(() => {})
    try {
      const output = model.read('term_worker')
      expect(output.sections.talkingWith).toHaveLength(population)
      expect(
        output.sections.talkingWith.every((row) => row.sendAddress && row.latest && row.openTarget)
      ).toBe(true)
      expect(sourceRows).toHaveBeenCalledOnce()
      const cold = sqlTotals(meter.executions)
      expect(cold.selected).toBe(4)
      expect(cold.keys).toBeLessThanOrEqual(10 * population + 10)
      expect(
        meter.executions.filter(
          (entry) => selectedKeyMultiplier(entry.sql) || entry.sql.includes('FROM legacy_adoptions')
        ).length
      ).toBeLessThanOrEqual(10)
      expect(model.read('term_worker')).toStrictEqual(output)
      expect(sqlTotals(meter.executions).selected).toBe(cold.selected)
      expect(sourceRows).toHaveBeenCalledOnce()
      f.db.crewChanges.notify(new Set(['topology']))
      expect(model.read('term_worker')).toEqual(output)
      expect(sqlTotals(meter.executions).selected).toBe(2 * cold.selected)
      expect(sourceRows).toHaveBeenCalledTimes(2)
      return { cold }
    } finally {
      stop()
      meter.restore()
      sourceRows.mockRestore()
    }
  })
  for (const field of ['all', 'get', 'rows', 'bytes', 'keys', 'requestChars'] as const) {
    expect(samples[1].cold[field]).toBeLessThanOrEqual(10 * samples[0].cold[field] + 100)
  }
})
