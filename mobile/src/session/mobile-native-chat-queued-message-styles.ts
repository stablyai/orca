import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

// A card's actions touch as 44pt targets (platform floor) inside its row: Android drops touches
// outside the parent, so the row is at least that tall and nothing overhangs it.
const MIN_TOUCH_TARGET = 44
const HEADER_HEIGHT = spacing.xl + spacing.sm
const META_LINE_HEIGHT = typography.metaSize + spacing.xs

export const queuedMessageStyles = StyleSheet.create({
  list: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.xs
  },
  box: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.row,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    overflow: 'hidden'
  },
  header: {
    minHeight: HEADER_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingLeft: spacing.md
  },
  // Large text: Clear all and Resume on a line of their own, under the label; at the largest sizes
  // one button is all a small phone's line holds, so they wrap.
  headerActionsLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: spacing.xs,
    paddingHorizontal: spacing.xs
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
  headerPaused: {
    backgroundColor: colors.bgRaised
  },
  headerLabel: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    lineHeight: META_LINE_HEIGHT,
    paddingVertical: spacing.sm
  },
  headerLabelPaused: {
    color: colors.textPrimary,
    fontWeight: '500'
  },
  headerCount: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    lineHeight: META_LINE_HEIGHT,
    paddingVertical: spacing.sm,
    fontVariant: ['tabular-nums']
  },
  // A long reason truncates in the space left; the count beside it never does.
  headerCaption: {
    flex: 1,
    minWidth: 0,
    color: colors.statusRed,
    fontSize: typography.metaSize,
    lineHeight: META_LINE_HEIGHT,
    paddingVertical: spacing.sm
  },
  // minHeight, not height: rows grow with the system text size instead of clipping.
  headerAction: {
    minHeight: HEADER_HEIGHT,
    minWidth: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.button
  },
  chevron: {
    width: 36,
    minHeight: HEADER_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center'
  },
  card: {
    minHeight: MIN_TOUCH_TARGET
  },
  row: {
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.md
  },
  divided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  textColumn: {
    flex: 1,
    minWidth: 0,
    paddingVertical: spacing.sm,
    gap: 2
  },
  bodyText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    lineHeight: typography.bodySize + 6
  },
  expandedBody: {
    paddingLeft: spacing.md + 14 + spacing.sm,
    paddingRight: spacing.md,
    paddingBottom: spacing.sm
  },
  caption: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  captionReturned: {
    color: colors.statusRed
  },
  actions: {
    flexDirection: 'row'
  },
  textAction: {
    minHeight: MIN_TOUCH_TARGET,
    minWidth: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.button
  },
  // The composer's 40pt button width; the row's last action keeps the full 44.
  iconAction: {
    minHeight: MIN_TOUCH_TARGET,
    width: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button
  },
  lastIconAction: {
    width: MIN_TOUCH_TARGET
  },
  actionLabel: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '500'
  },
  pressed: {
    backgroundColor: colors.bgRaised
  },
  disabled: {
    opacity: 0.5
  }
})
