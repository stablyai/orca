import { StyleSheet } from 'react-native'
import { colors, MIN_TOUCH_TARGET, motion, spacing, textStyles } from '../theme/mobile-theme'
import { composerTrayStyles } from './mobile-native-chat-composer-styles'

// A card's actions touch as 44pt targets inside its row: Android drops touches outside the parent,
// so the row is at least that tall and nothing overhangs it.
export const QUEUED_ICON_SIZE = 16
const ICON_SIZE = QUEUED_ICON_SIZE

export const queuedMessageStyles = StyleSheet.create({
  // A tray layer: inset from the composer's sides and tucked under its top edge.
  list: composerTrayStyles.layer,
  box: composerTrayStyles.panel,
  header: {
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xs
  },
  // Large text: Clear all and Resume on a line of their own, under the label; at the largest sizes
  // one button is all a small phone's line holds, so they wrap.
  headerActionsLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm
  },
  headerToggle: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0
  },
  headerLabels: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  headerPaused: { backgroundColor: colors.fill },
  headerLabel: {
    ...textStyles.footnote,
    fontWeight: '500',
    color: colors.textSecondary
  },
  headerLabelPaused: {
    color: colors.textPrimary
  },
  headerCount: {
    ...textStyles.footnote,
    fontWeight: '500',
    color: colors.textSecondary,
    fontVariant: ['tabular-nums']
  },
  // A long reason truncates in the space left; the count beside it never does.
  headerCaption: {
    ...textStyles.footnote,
    flex: 1,
    minWidth: 0,
    color: colors.danger
  },
  chevron: {
    width: 36,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center'
  },
  chevronOpen: { transform: [{ rotate: '0deg' }] },
  chevronClosed: { transform: [{ rotate: '-90deg' }] },
  card: {
    minHeight: MIN_TOUCH_TARGET
  },
  row: {
    minHeight: MIN_TOUCH_TARGET + 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingLeft: spacing.lg
  },
  divided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator
  },
  textColumn: {
    flex: 1,
    minWidth: 0,
    paddingVertical: spacing.sm,
    gap: 2
  },
  bodyText: {
    ...textStyles.callout,
    color: colors.textPrimary
  },
  expandedBody: {
    paddingLeft: spacing.lg + ICON_SIZE + spacing.md,
    paddingRight: spacing.lg,
    paddingBottom: spacing.sm
  },
  caption: {
    ...textStyles.footnote,
    color: colors.textMuted
  },
  captionReturned: {
    color: colors.danger
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: spacing.xs
  },
  pressed: {
    backgroundColor: colors.fill
  },
  disabled: {
    opacity: motion.disabledOpacity
  }
})
