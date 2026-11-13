import { StyleSheet } from 'react-native'
import { colors, concentricRadius, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'

// Footer buttons and the card's inner shapes follow the floating card's curve inward.
const MIN_TOUCH_TARGET = 44
export const ASK_CARD_PADDING = spacing.md
export const ASK_CHOICE_RADIUS = concentricRadius(radii.floating, ASK_CARD_PADDING)

export const mobileNativeChatAskStyles = themedStyleSheet(() => ({
  // Floats like the composer it replaces, with its own edge instead of a full-width rule.
  card: {
    flexShrink: 1,
    minHeight: 0,
    marginHorizontal: spacing.sm,
    marginBottom: 6,
    backgroundColor: colors.composerSurface,
    borderRadius: radii.floating,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.floatingCardBorder,
    overflow: 'hidden'
  },
  tabs: {
    flexGrow: 0,
    paddingTop: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  tabsContent: {
    paddingHorizontal: ASK_CARD_PADDING,
    gap: spacing.xs,
    alignItems: 'center'
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 36,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent'
  },
  tabActive: {
    borderBottomColor: colors.statusGreen
  },
  tabText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  tabTextActive: {
    color: colors.textPrimary
  },
  scroll: {
    paddingHorizontal: ASK_CARD_PADDING,
    paddingTop: spacing.xs
  },
  questionRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  questionText: {
    flex: 1,
    marginVertical: 10
  },
  other: {
    marginBottom: spacing.xs
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: spacing.sm,
    paddingHorizontal: ASK_CARD_PADDING,
    paddingBottom: ASK_CARD_PADDING,
    gap: spacing.sm
  },
  cancel: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    borderRadius: ASK_CHOICE_RADIUS
  },
  cancelText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  progress: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  next: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: ASK_CHOICE_RADIUS,
    borderWidth: 1,
    borderColor: colors.textPrimary,
    backgroundColor: colors.textPrimary
  },
  // An outline, not a grey fill: Skip is a real choice and must not read as disabled.
  nextSkip: {
    backgroundColor: 'transparent',
    borderColor: colors.choiceBorder
  },
  nextText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  nextSkipText: {
    color: colors.textPrimary
  }
}))
