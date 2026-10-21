import { describe, expect, it } from 'vitest'
import { isDashboardCustomLanes, isDashboardLaneAction } from './dashboard-lane-payload-validation'

describe('isDashboardLaneAction', () => {
  it('accepts each well-formed action', () => {
    expect(isDashboardLaneAction({ kind: 'add', label: 'Waiting' })).toBe(true)
    expect(isDashboardLaneAction({ kind: 'rename', laneId: 'l1', label: 'Parked' })).toBe(true)
    expect(isDashboardLaneAction({ kind: 'remove', laneId: 'l1' })).toBe(true)
    expect(isDashboardLaneAction({ kind: 'place', paneKey: 'tab:1', laneId: 'l1' })).toBe(true)
    expect(isDashboardLaneAction({ kind: 'place', paneKey: 'tab:1', laneId: null })).toBe(true)
  })

  it('rejects unknown kinds, empty or oversized labels and missing ids', () => {
    expect(isDashboardLaneAction({ kind: 'drop-table' })).toBe(false)
    expect(isDashboardLaneAction({ kind: 'add', label: '' })).toBe(false)
    expect(isDashboardLaneAction({ kind: 'add', label: 'x'.repeat(41) })).toBe(false)
    expect(isDashboardLaneAction({ kind: 'remove' })).toBe(false)
    expect(isDashboardLaneAction({ kind: 'place', paneKey: 'tab:1' })).toBe(false)
    expect(isDashboardLaneAction(null)).toBe(false)
  })
})

describe('isDashboardCustomLanes', () => {
  it('accepts undefined and well-formed lanes', () => {
    expect(isDashboardCustomLanes(undefined)).toBe(true)
    expect(isDashboardCustomLanes([{ id: 'l1', label: 'Waiting' }])).toBe(true)
  })

  it('rejects malformed lanes and oversized lists', () => {
    expect(isDashboardCustomLanes([{ id: 'l1' }])).toBe(false)
    expect(isDashboardCustomLanes('Waiting')).toBe(false)
    expect(
      isDashboardCustomLanes(Array.from({ length: 9 }, (_, i) => ({ id: `l${i}`, label: 'L' })))
    ).toBe(false)
  })
})
