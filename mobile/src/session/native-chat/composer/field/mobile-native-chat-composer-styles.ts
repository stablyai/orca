import { spacing } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import {
  COMPOSER_CONTROL_SIZE,
  composerInputStyles
} from '../../../../components/composer-input/composer-input-styles'

/** Space above the composer box; the queue box above reaches through it. */
export const COMPOSER_INSET_TOP = 6
/** How far a box docked on the composer's top edge reaches under it, past its rounded corners. */
export const COMPOSER_TUCK = 12
// Reserve two control widths for the pill so a warning icon still leaves room for text.
export const COMPOSER_ATTACH_AND_MODEL_MIN_WIDTH = COMPOSER_CONTROL_SIZE * 3 + spacing.sm

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
  // Keep the attach button beside the model pill so the label truncates before the toolbar wraps.
  attachAndModel: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '100%',
    gap: spacing.sm
  },
  wrappedActionRow: {
    flexWrap: 'wrap'
  },
  modelRow: {
    width: '100%'
  },
  // One line while dictating: a long computer name truncates instead of wrapping and growing the composer.
  dictationLeading: {
    flexWrap: 'nowrap'
  }
}))
