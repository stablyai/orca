import { describe, expect, it } from 'vitest'
import { railRingStackFit } from './rail-ring-stack-fit'

const base = {
  ring: 41,
  overhang: 5,
  gap: 12,
  minGap: 8,
  paddingTop: 12,
  paddingBottom: 16,
  peek: 12
}

describe('railRingStackFit', () => {
  it('keeps the natural spacing when every ring fits', () => {
    expect(railRingStackFit({ ...base, count: 5, room: 400 })).toEqual({
      gap: 12,
      paddingBottom: 16,
      height: null,
      pitch: 53
    })
  })

  it('tightens the gaps before cutting any ring', () => {
    // 12 + 5*41 + 4*9 + 7 = 260
    expect(railRingStackFit({ ...base, count: 5, room: 260 })).toEqual({
      gap: 9,
      paddingBottom: 7,
      height: null,
      pitch: 50
    })
  })

  it('shows only whole rings, cut in the gap after the last one, when even tight gaps overflow', () => {
    const fit = railRingStackFit({ ...base, count: 5, room: 200 })
    // Three rings at pitch 49 end at 12 + 2*49 + 41 + 5 = 156; a fourth would need 205 + 12 of peek.
    expect(fit).toEqual({ gap: 8, paddingBottom: 7, height: 169, pitch: 49 })
    expect(fit.height!).toBeLessThanOrEqual(200)
    // Below the cut only the peek: the next ring starts at 159, so 10pt of its top edge shows, faded.
    expect(fit.height! - 12).toBeLessThanOrEqual(12 + 3 * 49)
  })
})
