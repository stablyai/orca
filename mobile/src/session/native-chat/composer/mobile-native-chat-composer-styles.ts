import { spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { composerInputStyles } from '../../../components/composer-input/composer-input-styles'

/** Space above the composer box; the queue box above reaches through it. */
export const COMPOSER_INSET_TOP = 6

export const mobileNativeChatComposerStyles = themedStyleSheet(() => ({
  composerInset: {
    paddingHorizontal: spacing.md,
    paddingTop: COMPOSER_INSET_TOP,
    paddingBottom: spacing.sm
  },
  // Bottom margin matches the sides, so the box sits evenly in the screen's corners.
  composerInsetCornerFit: {
    paddingBottom: 10
  },
  bar: { ...composerInputStyles.box, ...composerInputStyles.docked },
  // Wider bottom corners stay concentric with the rounded screen instead of poking into it.
  barCornerFit: {
    borderBottomLeftRadius: 34,
    borderBottomRightRadius: 34,
    paddingBottom: 14
  },
  dictationMeter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    flexGrow: 6,
    flexShrink: 0
  }
}))
