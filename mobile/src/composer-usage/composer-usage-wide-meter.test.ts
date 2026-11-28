import { describe, expect, it } from 'vitest'
import {
  WIDE_METER_MIN_ROOM,
  WIDE_PANE_MIN_WIDTH,
  composerUsagePaneAllowsWideMeter,
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

const wideLabels = { fullLabelWidth: 44, percentWidth: 52, gap: 8 }

describe('composerUsageWideMeterLayout pane width', () => {
  it('stays compact on a folded Duo and in Split View', () => {
    expect(composerUsagePaneAllowsWideMeter(466)).toBe(false)
    expect(composerUsageWideMeterWidth(220, 466)).toBeNull()
    for (const paneWidth of [375, 455.5, 611, WIDE_PANE_MIN_WIDTH - 1]) {
      expect(composerUsageWideMeterLayout({ room: 260, paneWidth, ...wideLabels })).toBeNull()
    }
  })

  it('stays compact until the pane has been measured', () => {
    expect(composerUsagePaneAllowsWideMeter(null)).toBe(false)
    expect(composerUsageWideMeterLayout({ room: 300, paneWidth: null, ...wideLabels })).toBeNull()
  })

  it('uses the wide meter on a full-screen iPad or unfolded Duo', () => {
    expect(composerUsagePaneAllowsWideMeter(867)).toBe(true)
    expect(composerUsageWideMeterLayout({ room: 380, paneWidth: 951, ...wideLabels })).toEqual({
      width: 285,
      resetText: 'full'
    })
    expect(
      composerUsageWideMeterLayout({ room: 340, paneWidth: WIDE_PANE_MIN_WIDTH, ...wideLabels })
    ).toEqual({ width: 255, resetText: 'full' })
  })

  it('keeps the compact meter on a wide pane whose row is crowded', () => {
    expect(
      composerUsageWideMeterLayout({
        room: WIDE_METER_MIN_ROOM - 1,
        paneWidth: 951,
        ...wideLabels
      })
    ).toBeNull()
  })
})
