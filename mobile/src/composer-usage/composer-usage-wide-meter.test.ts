import { describe, expect, it } from 'vitest'
import {
  composerUsageWideMeterLayout,
  composerUsageWideMeterWidth
} from './composer-usage-wide-meter'

describe('composerUsageWideMeterWidth', () => {
  it('keeps the compact meter without room, or in a narrow row', () => {
    expect(composerUsageWideMeterWidth(null)).toBeNull()
    expect(composerUsageWideMeterWidth(159)).toBeNull()
  })

  it('takes a bounded share of a wide row', () => {
    expect(composerUsageWideMeterWidth(160)).toBe(140)
    expect(composerUsageWideMeterWidth(200)).toBe(150)
    expect(composerUsageWideMeterWidth(1000)).toBe(360)
  })
})

describe('composerUsageWideMeterLayout', () => {
  it('keeps the full reset label while it fits beside the minimum bar', () => {
    // 60 + 40 + 2*8 + 60 = 176 of 200.
    expect(
      composerUsageWideMeterLayout({ room: 200, fullLabelWidth: 60, percentWidth: 40, gap: 8 })
    ).toEqual({ width: 176, resetText: 'full' })
  })

  it('falls back to the largest unit alone when the full label does not fit', () => {
    expect(
      composerUsageWideMeterLayout({ room: 170, fullLabelWidth: 120, percentWidth: 40, gap: 8 })
    ).toEqual({ width: 140, resetText: 'compact' })
  })

  it('shows the wide meter with the full label until the labels are measured', () => {
    expect(
      composerUsageWideMeterLayout({ room: 200, fullLabelWidth: null, percentWidth: null, gap: 8 })
    ).toEqual({ width: 150, resetText: 'full' })
    expect(
      composerUsageWideMeterLayout({ room: null, fullLabelWidth: null, percentWidth: null, gap: 8 })
    ).toBeNull()
  })
})
