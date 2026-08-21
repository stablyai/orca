import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export const mobileOnboardingStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  brandRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl
  },
  brandName: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: '700'
  },
  progress: {
    position: 'absolute',
    left: '50%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    transform: [{ translateX: -18 }]
  },
  progressDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
    backgroundColor: colors.borderSubtle
  },
  progressDotActive: {
    width: 22,
    backgroundColor: colors.textPrimary
  },
  carouselViewport: {
    flex: 1,
    overflow: 'hidden'
  },
  carouselTrack: {
    height: '100%',
    flexDirection: 'row'
  },
  page: {
    height: '100%'
  },
  // Why: every decision remains reachable in landscape and with accessibility
  // text scaling even though Back and swipe-to-skip are intentionally disabled.
  pageContent: {
    flexGrow: 1,
    paddingHorizontal: spacing.xl
  },
  content: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl
  },
  iconSurface: {
    width: 64,
    height: 64,
    borderRadius: radii.card,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    marginBottom: spacing.xl
  },
  title: {
    maxWidth: 420,
    color: colors.textPrimary,
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: -0.3,
    textAlign: 'center'
  },
  body: {
    maxWidth: 420,
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    lineHeight: 21,
    textAlign: 'center',
    marginTop: spacing.md
  },
  footer: {
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    paddingBottom: spacing.lg
  },
  primaryButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button,
    backgroundColor: colors.surfaceBright,
    paddingVertical: spacing.sm
  },
  primaryButtonText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  secondaryButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button,
    marginTop: spacing.xs,
    paddingVertical: spacing.sm
  },
  secondaryButtonText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  },
  buttonPressed: {
    opacity: 0.72
  },
  buttonDisabled: {
    opacity: 0.58
  },
  error: {
    color: colors.statusRed,
    fontSize: typography.metaSize,
    lineHeight: 18,
    textAlign: 'center',
    marginBottom: spacing.sm
  }
})
