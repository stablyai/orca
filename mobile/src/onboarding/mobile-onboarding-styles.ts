import { radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const mobileOnboardingStylesSheet = themedStyleSheet((colors) => ({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  brandRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg
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
    borderRadius: radii.pill,
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
  // Allow landscape/accessibility scrolling because Back and swipe-to-skip are disabled.
  pageContent: {
    flexGrow: 1,
    paddingHorizontal: spacing.lg
  },
  content: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: spacing.lg,
    paddingBottom: spacing.md
  },
  notificationContent: {
    justifyContent: 'flex-start',
    paddingTop: spacing.xl
  },
  iconSurface: {
    width: 64,
    height: 64,
    borderRadius: radii.tile,
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
    gap: spacing.sm,
    paddingBottom: spacing.lg
  },
  error: {
    color: colors.statusRed,
    fontSize: typography.metaSize,
    lineHeight: 18,
    textAlign: 'center'
  }
}))
