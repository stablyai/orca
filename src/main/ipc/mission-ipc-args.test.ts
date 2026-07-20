import { describe, expect, it } from 'vitest'
import { MissionUpdateArgs } from './mission-ipc-args'

describe('MissionUpdateArgs', () => {
  it('accepts non-empty names and finite tab orders', () => {
    expect(
      MissionUpdateArgs.safeParse({
        missionId: 'mission-1',
        updates: { name: 'Referral', tabOrder: 2 }
      }).success
    ).toBe(true)
  })

  it('rejects empty names', () => {
    expect(
      MissionUpdateArgs.safeParse({ missionId: 'mission-1', updates: { name: '' } }).success
    ).toBe(false)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite tab order %s',
    (tabOrder) => {
      expect(
        MissionUpdateArgs.safeParse({ missionId: 'mission-1', updates: { tabOrder } }).success
      ).toBe(false)
    }
  )
})
