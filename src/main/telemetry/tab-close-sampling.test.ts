import { describe, expect, it } from 'vitest'
import { isInTabCloseTelemetrySample } from './tab-close-sampling'

describe('tab close telemetry sampling', () => {
  it('keeps known anonymous installs consistently inside or outside the sample', () => {
    for (let index = 0; index < 10; index++) {
      expect(isInTabCloseTelemetrySample('00000000-0000-4000-8000-000000000013')).toBe(true)
      expect(isInTabCloseTelemetrySample('00000000-0000-4000-8000-000000000000')).toBe(false)
    }
  })

  it('selects about ten percent of a fixed set of installs', () => {
    let sampled = 0
    for (let index = 0; index < 10_000; index++) {
      const installId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
      if (isInTabCloseTelemetrySample(installId)) {
        sampled++
      }
    }
    expect(sampled).toBeGreaterThan(900)
    expect(sampled).toBeLessThan(1100)
  })
})
