import { StyleSheet } from 'react-native'
import { colors, MIN_TOUCH_TARGET, motion, spacing } from '../theme/mobile-theme'

/** The filled circles on the action row: +, mic, Send and Stop. */
export const COMPOSER_CONTROL_SIZE = 36
/** Space above the composer box; the tray layers above reach through it. */
export const COMPOSER_INSET_TOP = 6
/** 28 so the 36 pt controls, 10 pt in, sit concentric with the corners. */
export const COMPOSER_RADIUS = 28
const BOX_PADDING = 10
// Each control's 44 pt touch box overhangs its 36 pt circle into the box's padding.
const TOUCH_OVERHANG = (MIN_TOUCH_TARGET - COMPOSER_CONTROL_SIZE) / 2

export const mobileNativeChatComposerStyles = StyleSheet.create({
  composerInset: {
    paddingHorizontal: 10,
    paddingTop: COMPOSER_INSET_TOP,
    paddingBottom: spacing.sm
  },
  // Dark mode draws no shadow: the box is told apart by its fill and a faint edge.
  bar: {
    paddingTop: spacing.md,
    paddingHorizontal: BOX_PADDING,
    paddingBottom: BOX_PADDING,
    borderWidth: 1,
    borderColor: colors.separator,
    borderRadius: COMPOSER_RADIUS,
    backgroundColor: colors.composerSurface
  },
  barFocused: {
    borderColor: colors.fieldBorderFocused
  },
  barLocked: {
    opacity: motion.disabledOpacity
  },
  actionRow: {
    marginTop: spacing.sm - TOUCH_OVERHANG,
    marginHorizontal: -TOUCH_OVERHANG,
    marginBottom: -TOUCH_OVERHANG,
    flexDirection: 'row',
    alignItems: 'center'
  },
  actionSpacer: {
    flex: 1
  },
  // Starts where the box would, so a tray layer tucked above loses only its tuck to it.
  sendError: {
    marginTop: COMPOSER_INSET_TOP,
    paddingBottom: spacing.xs,
    backgroundColor: colors.bgBase
  }
})

/** How far a tray layer runs under whatever sits below it: the next layer or the composer box. */
export const COMPOSER_TRAY_TUCK = 12

/**
 * The tray's one shape: everything that grows out of the composer (prompt cards, background work,
 * queued drafts) is an inset panel whose bottom tucks under the next layer down, folder-tab style.
 */
export const composerTrayStyles = StyleSheet.create({
  layer: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: -(COMPOSER_INSET_TOP + COMPOSER_TRAY_TUCK)
  },
  panel: {
    paddingBottom: COMPOSER_TRAY_TUCK,
    backgroundColor: colors.bgPanel,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: colors.separator,
    overflow: 'hidden'
  }
})
