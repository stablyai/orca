import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const RING_SIZE = 72

export const styles = themedStyleSheet(() => ({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  scroll: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm
  },
  // On a screen, not a sheet: one step above the page, as the other screen groups are.
  group: {
    backgroundColor: colors.bgPanel
  },
  quiet: {
    paddingTop: spacing.xl,
    fontSize: typography.bodySize,
    lineHeight: 20,
    color: colors.textMuted
  },
  problem: {
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    fontSize: typography.bodySize,
    lineHeight: 20,
    color: colors.textPrimary
  },
  loading: {
    paddingTop: spacing.xl,
    alignItems: 'flex-start'
  },
  block: {
    padding: spacing.lg,
    gap: spacing.md
  },
  cpuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md
  },
  cpuFacts: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs
  },
  ringBox: {
    width: RING_SIZE,
    height: RING_SIZE,
    alignItems: 'center',
    justifyContent: 'center'
  },
  ringPercent: {
    position: 'absolute',
    width: RING_SIZE - 18,
    fontSize: typography.titleSize,
    lineHeight: 22,
    color: colors.textPrimary,
    fontWeight: '600',
    textAlign: 'center'
  },
  body: {
    fontSize: typography.bodySize,
    lineHeight: 20,
    color: colors.textPrimary
  },
  model: {
    fontSize: typography.bodySize,
    lineHeight: 20,
    color: colors.textMuted
  },
  meta: {
    fontSize: typography.metaSize,
    lineHeight: 18,
    color: colors.textMuted
  },
  caption: {
    fontSize: typography.metaSize,
    lineHeight: 18,
    color: colors.textSecondary
  },
  sparkline: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: spacing.xl,
    gap: spacing.xs
  },
  sparkTrack: {
    flex: 1,
    height: '100%',
    justifyContent: 'flex-end',
    backgroundColor: colors.bgRaised,
    borderRadius: radii.mark,
    overflow: 'hidden'
  },
  sparkFill: {
    width: '100%'
  },
  cores: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs
  },
  coreTrack: {
    width: 18,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.bgRaised,
    overflow: 'hidden'
  },
  coreFill: {
    height: '100%'
  },
  meter: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.xs
  },
  quietMeter: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.xs
  },
  meterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  track: {
    flex: 1,
    height: 6,
    borderRadius: radii.mark,
    backgroundColor: colors.bgRaised,
    overflow: 'hidden'
  },
  fill: {
    height: '100%'
  },
  empty: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: typography.bodySize,
    lineHeight: 20,
    color: colors.textMuted
  },
  footer: {
    paddingTop: spacing.md,
    fontSize: typography.metaSize,
    lineHeight: 18,
    color: colors.textMuted
  }
}))
