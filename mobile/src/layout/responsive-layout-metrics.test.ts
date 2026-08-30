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

  it('keeps window class stable while resizing around the 600 and 840 dp breakpoints', () => {
    const medium = getResponsiveLayoutMetrics(700, 600)
    expect(medium.windowClass).toBe('medium')
    expect(getResponsiveLayoutMetrics(590, 600, medium).windowClass).toBe('medium')
    expect(getResponsiveLayoutMetrics(575, 600, medium).windowClass).toBe('compact')
    expect(getResponsiveLayoutMetrics(850, 600, medium).windowClass).toBe('medium')
    expect(getResponsiveLayoutMetrics(864, 600, medium).windowClass).toBe('expanded')

    const compact = getResponsiveLayoutMetrics(500, 600)
    expect(getResponsiveLayoutMetrics(610, 600, compact).windowClass).toBe('compact')
    expect(getResponsiveLayoutMetrics(624, 600, compact).windowClass).toBe('medium')

    const expanded = getResponsiveLayoutMetrics(1000, 600)
    expect(getResponsiveLayoutMetrics(830, 600, expanded).windowClass).toBe('expanded')
    expect(getResponsiveLayoutMetrics(815, 600, expanded).windowClass).toBe('medium')
  })
})
