import { StyleSheet } from 'react-native'
import { colors, radii, spacing, textStyles } from '../theme/mobile-theme'
import { slideTransition } from '../components/ui/transition-styles'

const CONTENT_MAX_WIDTH = 420

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
    ...textStyles.headline,
    color: colors.textPrimary
  },
  progress: {
    position: 'absolute',
    left: '50%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    transform: [{ translateX: -17 }]
  },
  progressDot: {
    width: 6,
    height: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.fillPressed,
    ...slideTransition
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
    paddingTop: spacing.lg,
    paddingBottom: spacing.md
  },
  notificationContent: {
    justifyContent: 'flex-start',
    paddingTop: spacing.xl
  },
  title: {
    ...textStyles.largeTitle,
    maxWidth: CONTENT_MAX_WIDTH,
    color: colors.textPrimary,
    textAlign: 'center'
  },
  body: {
    ...textStyles.body,
    maxWidth: CONTENT_MAX_WIDTH,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.md
  },
  footer: {
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
    paddingBottom: spacing.lg
  },
  disclosure: {
    ...textStyles.footnote,
    color: colors.textMuted,
    textAlign: 'center',
    marginBottom: spacing.lg
  },
  choices: {
    gap: spacing.xs
  },
  error: {
    ...textStyles.footnote,
    color: colors.danger,
    textAlign: 'center',
    marginBottom: spacing.md
  }
})
