import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../../../../theme/mobile-theme'
import {
  COMPOSER_INSET_TOP,
  COMPOSER_TUCK
} from '../../composer/field/mobile-native-chat-composer-styles'
import { themedStyleSheet } from '../../../../theme/themed-styles'

// Keep 44pt targets inside the parent row because Android drops outside touches.
const MIN_TOUCH_TARGET = 44
const HEADER_HEIGHT = spacing.xl + spacing.sm
const META_LINE_HEIGHT = typography.metaSize + spacing.xs
const QUEUE_BOX_RADIUS = 20
const ROW_MIN_HEIGHT = 52
/** Below this width a one-line message shows too little, so it takes two and the pill drops its arrow. */
export const QUEUED_ROW_NARROW_WIDTH = 340
const STEER_PILL_HEIGHT = 32

export const queuedMessageStyles = themedStyleSheet(() => ({
  list: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.xs,
    marginBottom: -(COMPOSER_INSET_TOP + COMPOSER_TUCK)
  },
  box: {
    paddingBottom: COMPOSER_TUCK,
    backgroundColor: colors.bgPanel,
    borderTopLeftRadius: radii.surface,
    borderTopRightRadius: radii.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    borderColor: colors.composerBorder,
    overflow: 'hidden'
  },
  // Full editors and menus scroll above the ordinary composer instead of tucking under it.
  inlineList: { flexShrink: 1, minHeight: 0, marginBottom: 0 },
  inlineBox: { flexShrink: 1, minHeight: 0, paddingBottom: 0 },
  // Above a prompt card: a closed box of its own, matching the card's surface and inset.
  closedList: { marginHorizontal: spacing.sm, marginTop: 0, marginBottom: 6 },
  closedBox: {
    backgroundColor: colors.composerSurface,
    // Every corner: the tucked box's own top corners would outrank a plain borderRadius.
    borderTopLeftRadius: QUEUE_BOX_RADIUS,
    borderTopRightRadius: QUEUE_BOX_RADIUS,
    borderBottomLeftRadius: QUEUE_BOX_RADIUS,
    borderBottomRightRadius: QUEUE_BOX_RADIUS,
    borderBottomWidth: StyleSheet.hairlineWidth
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
  // minHeight, not height: rows grow with the system text size instead of clipping.
  headerAction: {
    minHeight: HEADER_HEIGHT,
    minWidth: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.control
  },
  card: {
    minHeight: MIN_TOUCH_TARGET
  },
  row: {
    minHeight: ROW_MIN_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: spacing.sm,
    paddingLeft: spacing.md,
    paddingRight: 6
  },
  // The grip takes the leading inset, so the row starts at its edge.
  rowWithHandle: {
    paddingLeft: 0,
    gap: 6
  },
  divided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.composerBorder
  },
  textColumn: {
    flex: 1,
    minWidth: 0,
    gap: 2
  },
  metaLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minWidth: 0
  },
  metaLead: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    lineHeight: META_LINE_HEIGHT,
    fontWeight: '600',
    flexShrink: 1
  },
  metaText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    lineHeight: META_LINE_HEIGHT,
    flexShrink: 1
  },
  metaFixed: {
    flexShrink: 0
  },
  metaSenders: {
    flexShrink: 1,
    minWidth: 0
  },
  bodyText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    lineHeight: typography.bodySize + 5
  },
  expandedBody: {
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    paddingBottom: spacing.sm
  },
  caption: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  editorHeading: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.xs
  },
  captionReturned: {
    color: colors.statusRed
  },
  // 32pt tall to sit light in the row; hitSlop carries it to 44pt inside the row's own height.
  steerPill: {
    minHeight: STEER_PILL_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: 11,
    borderRadius: radii.pill,
    backgroundColor: colors.cardPillFill,
    flexShrink: 0
  },
  steerLabel: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '600'
  },
  moreButton: {
    width: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
    flexShrink: 0
  },
  // The fold row: "N more ▼" under the first message, "Show less ▲" under the open list.
  foldToggle: {
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.composerBorder
  },
  foldLabel: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '500',
    flexShrink: 1
  },
  actionLabel: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '500'
  },
  pressed: {
    backgroundColor: colors.bgRaised
  },
  // The head card the composer's Steer queued would send; translucent so its Steer pill still shows.
  lit: {
    backgroundColor: colors.translucentFill
  },
  // The lit row's Steer pill fills like the composer's primary (orca #40820).
  litAction: {
    backgroundColor: colors.surfaceBright
  },
  litActionLabel: {
    color: colors.bgBase
  },
  disabled: {
    opacity: 0.5
  }
}))
