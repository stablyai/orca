import { expect, it } from 'vitest'
import { AcpSubagents } from './acp-subagents'

it('delivers the same result again after an explicit restart while suppressing duplicate completions', () => {
  const lane = new AcpSubagents()
  const join = { thread: 'parent' }
  const completed = { id: 'child', state: 'completed', result: 'DONE' } as const
  expect(lane.translate([completed], join, 1)).toHaveLength(1)
  expect(lane.translate([completed], join, 2)).toHaveLength(0)
  lane.translate([{ id: 'child', state: 'working', restart: true }], join, 3)
  expect(lane.translate([completed], join, 4)).toHaveLength(1)
})
