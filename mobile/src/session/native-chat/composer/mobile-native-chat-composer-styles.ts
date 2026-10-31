import { spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { composerInputStyles } from '../../../components/composer-input/composer-input-styles'

/** Space above the composer box; the queue box above reaches through it. */
export const COMPOSER_INSET_TOP = 6

export const mobileNativeChatComposerStyles = themedStyleSheet(() => ({
  composerInset: {
    paddingHorizontal: 10,
    paddingTop: COMPOSER_INSET_TOP,
    paddingBottom: spacing.sm
  },
  bar: { ...composerInputStyles.box, ...composerInputStyles.docked },
  dictationMeter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    flexGrow: 6,
    flexShrink: 0
  }
}))
