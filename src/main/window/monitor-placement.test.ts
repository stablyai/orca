import { describe, expect, it } from 'vitest'
import {
  isValidWindowPlacement,
  readMonitorDisplays,
  recoverWindowPlacement,
  distributeWindowPlacements,
  tileWindowPlacements,
  type MonitorDisplay
} from './monitor-placement'

const displays: MonitorDisplay[] = [
  { id: 1, scaleFactor: 1, workArea: { x: -1920, y: 0, width: 1920, height: 1080 } },
  { id: 2, scaleFactor: 2, workArea: { x: 0, y: -900, width: 1440, height: 900 } }
]

describe('recoverWindowPlacement', () => {
  it('preserves reachable placement on a negative-origin display', () => {
    const saved = { x: -1700, y: 40, width: 1200, height: 800 }

    expect(recoverWindowPlacement(saved, displays)).toEqual(saved)
  })

  it('preserves reachable placement across displays with different scale factors', () => {
    const saved = { x: 100, y: -850, width: 1000, height: 700 }

    expect(recoverWindowPlacement(saved, displays)).toEqual(saved)
  })

  it('moves an off-screen titlebar into the nearest current work area', () => {
    expect(recoverWindowPlacement({ x: 1500, y: 100, width: 1000, height: 700 }, displays)).toEqual(
      { x: 440, y: -700, width: 1000, height: 700 }
    )
  })

  it('keeps an oversized window reachable without changing its saved size', () => {
    expect(
      recoverWindowPlacement({ x: 3000, y: 2000, width: 1800, height: 1200 }, [displays[1]])
    ).toEqual({ x: 0, y: -900, width: 1800, height: 1200 })
  })
})

it('recovers a titlebar with only a one-pixel visible sliver', () => {
  expect(
    recoverWindowPlacement({ x: 0, y: -47, width: 600, height: 400 }, [
      { id: 1, scaleFactor: 1, workArea: { x: 0, y: 0, width: 800, height: 600 } }
    ])
  ).toEqual({ x: 0, y: 0, width: 600, height: 400 })
})

it('places an oversized window at the origin of a tiny work area and stays stable', () => {
  const tiny = [{ id: 1, scaleFactor: 2, workArea: { x: -20, y: 10, width: 80, height: 30 } }]
  const recovered = recoverWindowPlacement({ x: 200, y: 200, width: 1000, height: 800 }, tiny)
  expect(recovered).toEqual({ x: -20, y: 10, width: 1000, height: 800 })
  expect(recoverWindowPlacement(recovered, tiny)).toBe(recovered)
})

it('rejects malformed saved bounds and ignores unusable displays', () => {
  expect(isValidWindowPlacement({ x: Number.NaN, y: 0, width: 1000, height: 800 })).toBe(false)
  const saved = { x: 2000, y: 2000, width: 1000, height: 800 }
  expect(
    recoverWindowPlacement(saved, [{ ...displays[0], workArea: { ...saved, width: 0 } }])
  ).toBe(saved)
})

it('tolerates an unavailable display service', () => {
  expect(
    readMonitorDisplays(() => {
      throw new Error('screen unavailable')
    })
  ).toEqual([])
})

it('tiles windows into a balanced grid inside the monitor work area', () => {
  expect(tileWindowPlacements(displays[0], 3)).toEqual([
    { x: -1908, y: 12, width: 942, height: 522 },
    { x: -954, y: 12, width: 942, height: 522 },
    { x: -1908, y: 546, width: 942, height: 522 }
  ])
})

it('distributes windows round-robin while preserving monitor origins', () => {
  expect(distributeWindowPlacements(displays, 3)).toEqual([
    { x: -1908, y: 12, width: 942, height: 1056 },
    { x: 12, y: -888, width: 1416, height: 876 },
    { x: -954, y: 12, width: 942, height: 1056 }
  ])
})
