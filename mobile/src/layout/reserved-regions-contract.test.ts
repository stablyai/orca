import { describe, expect, it } from 'vitest'
import { partitionReservedRegions } from './reserved-regions-contract'

describe('provider-local reserved regions', () => {
  it('translates an inset provider into window points without changing the region size', () => {
    expect(
      partitionReservedRegions(
        [
          {
            kind: 'division',
            frame: { x: 400, y: 0, width: 12, height: 760 },
            occludesContent: false
          }
        ],
        { x: 20, y: 40 }
      )
    ).toEqual({
      divisions: [{ x: 420, y: 40, width: 12, height: 760 }],
      occlusions: []
    })
  })
  it('keeps the fold and camera frames in the root provider coordinate space', () => {
    const fold = { x: 420, y: 0, width: 12, height: 800 }
    const camera = { x: 800, y: 20, width: 84, height: 160 }
    expect(
      partitionReservedRegions([
        { kind: 'division', frame: fold, occludesContent: false },
        { kind: 'occlusion', frame: camera }
      ])
    ).toEqual({ divisions: [fold], occlusions: [camera] })
  })

  it('clears both geometry inputs when no region is active', () => {
    expect(partitionReservedRegions([])).toEqual({ divisions: [], occlusions: [] })
  })
})
