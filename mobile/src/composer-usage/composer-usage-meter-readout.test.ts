import { describe, expect, it } from 'vitest'
import { composerUsageMeterReadout } from './composer-usage-meter-readout'

describe('composer usage meter readout', () => {
  it('keeps today’s used label and fill', () => {
    expect(composerUsageMeterReadout(6, 'used')).toEqual({ used: 6, shown: 6 })
  })

  it('shows the remainder while the band still follows consumption', () => {
    // 6% used is 94% left, and the bar color is chosen from 6, not 94.
    expect(composerUsageMeterReadout(6, 'remaining')).toEqual({ used: 6, shown: 94 })
    expect(composerUsageMeterReadout(94, 'remaining')).toEqual({ used: 94, shown: 6 })
  })

  it('complements the rounded used percent', () => {
    expect(composerUsageMeterReadout(20.5, 'remaining')).toEqual({ used: 21, shown: 79 })
  })
})
