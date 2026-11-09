import { spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { composerInputStyles } from '../../../components/composer-input/composer-input-styles'

/** Space above the composer box; the queue box above reaches through it. */
export const COMPOSER_INSET_TOP = 6
/** How far a box docked on the composer's top edge reaches under it, past its rounded corners. */
export const COMPOSER_TUCK = 12

export const mobileNativeChatComposerStyles = themedStyleSheet(() => ({
  composerInset: {
    paddingHorizontal: spacing.md,
    paddingTop: COMPOSER_INSET_TOP,
    paddingBottom: spacing.sm
  },
  bar: composerInputStyles.box,
  leadingControls: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm
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
