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
      isWideLayout: true,
      isLandscapePhone: false
    })
  })

  it('splits an unfolded iPhone Duo in both holds and keeps its cover phone-like', () => {
    expect(getResponsiveLayoutMetrics(951, 669)).toMatchObject({ isWideLayout: true })
    expect(getResponsiveLayoutMetrics(669, 951)).toMatchObject({ isWideLayout: true })
    expect(getResponsiveLayoutMetrics(466, 678)).toMatchObject({
      isTabletLayout: false,
      isWideLayout: false,
      isLandscapePhone: false
    })
    expect(getResponsiveLayoutMetrics(678, 466)).toMatchObject({
      isWideLayout: false,
      isLandscapePhone: true
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
      isLandscapePhone: true,
      horizontalPadding: spacing.lg
    })
    expect(getResponsiveLayoutMetrics(430, 932)).toMatchObject({ isLandscapePhone: false })
    // A short, narrow web window is wider than tall but has no room for tabs in the top bar.
    expect(getResponsiveLayoutMetrics(390, 350)).toMatchObject({ isLandscapePhone: false })
  })
})
