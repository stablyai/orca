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
})
