import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { COMPOSER_INSET_TOP } from '../composer/mobile-native-chat-composer-styles'
import { themedStyleSheet } from '../../../theme/themed-styles'

// Keep 44pt targets inside the parent row because Android drops outside touches.
const MIN_TOUCH_TARGET = 44
const HEADER_HEIGHT = spacing.xl + spacing.sm
const META_LINE_HEIGHT = typography.metaSize + spacing.xs

const COMPOSER_TUCK = 12

export const queuedMessageStyles = themedStyleSheet(() => ({
  list: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.xs,
    marginBottom: -(COMPOSER_INSET_TOP + COMPOSER_TUCK)
  },
  box: {
    paddingBottom: COMPOSER_TUCK,
    backgroundColor: colors.bgPanel,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    borderColor: colors.composerBorder,
    overflow: 'hidden'
  },
  header: {
    minHeight: HEADER_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingLeft: spacing.md
  },
  // Wrap header actions onto their own lines at large text sizes.
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
    borderTopColor: colors.composerBorder
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
}))
