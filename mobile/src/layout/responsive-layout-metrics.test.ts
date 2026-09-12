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

  it('uses wide layout on sufficiently wide landscape phones', () => {
    expect(getResponsiveLayoutMetrics(932, 430)).toMatchObject({
      isLandscape: true,
      isTabletLayout: false,
      isWideLayout: true,
      horizontalPadding: spacing.xl
    })
  })

  it.each([
    {
      width: 699,
      height: 430,
      isLandscape: true,
      isTabletLayout: false,
      isWideLayout: false,
      label: 'landscape phone below 700px'
    },
    {
      width: 700,
      height: 430,
      isLandscape: true,
      isTabletLayout: false,
      isWideLayout: true,
      label: 'landscape phone at 700px'
    },
    {
      width: 700,
      height: 700,
      isLandscape: false,
      isTabletLayout: true,
      isWideLayout: true,
      label: 'square tablet at 700px'
    },
    {
      width: 699,
      height: 700,
      isLandscape: false,
      isTabletLayout: true,
      isWideLayout: false,
      label: 'tablet window below 700px'
    },
    {
      width: 600,
      height: 900,
      isLandscape: false,
      isTabletLayout: true,
      isWideLayout: false,
      label: 'tablet short side at 600px'
    },
    {
      width: 599,
      height: 900,
      isLandscape: false,
      isTabletLayout: false,
      isWideLayout: false,
      label: 'tablet short side below 600px'
    }
  ])('classifies $label', ({ width, height, isLandscape, isTabletLayout, isWideLayout }) => {
    expect(getResponsiveLayoutMetrics(width, height)).toMatchObject({
      isLandscape,
      isTabletLayout,
      isWideLayout
    })
  })
})
