import { describe, expect, it } from 'vitest'
import { railRingStackFit, type RailRingStackFit } from './rail-ring-stack-fit'

const base = {
  ring: 41,
  overhang: 5,
  gap: 12,
  minGap: 8,
  paddingTop: 12,
  paddingBottom: 16,
  peek: 12
}

/** Each ring's arc top and label bottom, as the column lays them out. */
function rings(fit: RailRingStackFit, count: number): { top: number; labelBottom: number }[] {
  return Array.from({ length: count }, (_, index) => {
    const top = base.paddingTop + index * (base.ring + fit.gap)
    return { top, labelBottom: top + base.ring + base.overhang }
  })
}

describe('railRingStackFit', () => {
  it('leaves a full gap between each percent label and the next ring', () => {
    const fit = railRingStackFit({ ...base, count: 5, room: 400 })
    expect(fit).toEqual({ gap: 17, paddingBottom: 21, height: null, pitch: 58 })
    const laid = rings(fit, 5)
    for (let index = 1; index < laid.length; index++) {
      expect(laid[index].top - laid[index - 1].labelBottom).toBe(12)
      expect(laid[index].top - laid[index - 1].top).toBe(fit.pitch)
    }
    // 12 + 5*46 + 4*12 + 16 = 306
    expect(laid[4].labelBottom + fit.paddingBottom - base.overhang).toBe(306)
  })

  it('tightens the gaps before cutting any ring, and never below the minimum', () => {
    // 12 + 5*46 + 4*9 + 2 = 280
    const fit = railRingStackFit({ ...base, count: 5, room: 280 })
    expect(fit).toEqual({ gap: 14, paddingBottom: 7, height: null, pitch: 55 })
    const laid = rings(fit, 5)
    expect(laid[1].top - laid[0].labelBottom).toBe(9)
    expect(laid[4].labelBottom + fit.paddingBottom - base.overhang).toBeLessThanOrEqual(280)
  })

  it('shows only whole rings, labels included, cut in the gap after the last one', () => {
    const fit = railRingStackFit({ ...base, count: 5, room: 200 })
    // Three rings at pitch 54 end their labels at 12 + 2*54 + 46 = 166; a fourth would need 220 + peek.
    expect(fit).toEqual({ gap: 13, paddingBottom: 7, height: 179, pitch: 54 })
    const laid = rings(fit, 5)
    expect(laid[1].top - laid[0].labelBottom).toBe(8)
    expect(fit.height!).toBeLessThanOrEqual(200)
    // The fade starts below the third label and above the fourth ring's top.
    expect(fit.height! - base.peek).toBeGreaterThanOrEqual(laid[2].labelBottom)
    expect(fit.height! - base.peek).toBeLessThanOrEqual(laid[3].top)
  })
})
