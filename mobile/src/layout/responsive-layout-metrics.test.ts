import { describe, expect, it } from 'vitest'
import { getResponsiveLayoutMetrics } from './responsive-layout-metrics'
import { spacing } from '../theme/mobile-theme'

describe('responsive layout metrics', () => {
  it('uses capped tablet layout for iPad portrait and landscape windows', () => {
    expect(getResponsiveLayoutMetrics(820, 1180)).toMatchObject({
      isLandscape: false,
      isTabletLayout: true,
      isWideLayout: true,
      contentMaxWidth: 720,
      modalMaxWidth: 480,
      horizontalPadding: spacing.xl
    })

    expect(getResponsiveLayoutMetrics(1180, 820)).toMatchObject({
      isLandscape: true,
      isTabletLayout: true,
      isWideLayout: true
    })
  })

  it('keeps narrow iPad split windows phone-like', () => {
    expect(getResponsiveLayoutMetrics(560, 1024)).toMatchObject({
      isTabletLayout: false,
      isWideLayout: false,
      horizontalPadding: spacing.lg
    })
  })

  it('keeps landscape phones out of wide tablet layout', () => {
    expect(getResponsiveLayoutMetrics(932, 430)).toMatchObject({
      isLandscape: true,
      isTabletLayout: false,
      isWideLayout: false,
      horizontalPadding: spacing.lg
    })
  })

  it('classifies freeform desktop windows by their bounds', () => {
    expect(getResponsiveLayoutMetrics(800, 600).windowClass).toBe('medium')
    expect(getResponsiveLayoutMetrics(1024, 768).windowClass).toBe('expanded')
    expect(getResponsiveLayoutMetrics(1280, 720).windowClass).toBe('expanded')
    expect(getResponsiveLayoutMetrics(1920 / 1.5, 1080 / 1.5).windowClass).toBe('expanded')
  })

  it('keeps wide layout stable while resizing around the breakpoint', () => {
    const wide = getResponsiveLayoutMetrics(760, 700)
    expect(getResponsiveLayoutMetrics(690, 700, wide).isWideLayout).toBe(true)
    expect(getResponsiveLayoutMetrics(675, 700, wide).isWideLayout).toBe(false)
  })
})
