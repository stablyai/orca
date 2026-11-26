import { spacing } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import {
  COMPOSER_CONTROL_SIZE,
  COMPOSER_LINE_HEIGHT,
  composerInputStyles
} from '../../../../components/composer-input/composer-input-styles'

/** Space above the composer box; the queue box above reaches through it. */
export const COMPOSER_INSET_TOP = 6
/** How far a box docked on the composer's top edge reaches under it, past its rounded corners. */
export const COMPOSER_TUCK = 12

/** The box's edge, top and bottom, which its eased height counts. */
export const COMPOSER_BOX_EDGE = 1
/** The pill's inset and the gap between its +, field and send slot. */
export const COMPOSER_PILL_GAP = spacing.sm
// The field's 2 pt text inset sits inside this, so its line centres on the 38 pt row.
const PILL_FIELD_TOP = COMPOSER_PILL_GAP + (COMPOSER_CONTROL_SIZE - COMPOSER_LINE_HEIGHT) / 2 - 2

export const mobileNativeChatComposerStyles = themedStyleSheet(() => ({
  composerInset: {
    paddingHorizontal: spacing.md,
    paddingTop: COMPOSER_INSET_TOP,
    paddingBottom: spacing.sm
  },
  // The box draws its look and holds its height; the content inside sets the padding.
  bar: { ...composerInputStyles.box, padding: 0, justifyContent: 'flex-end' },
  barContent: { flexShrink: 0, padding: spacing.md },
  // Idle and empty: one row of +, the field and the send slot.
  barContentPill: { padding: COMPOSER_PILL_GAP },
  pillField: {
    position: 'absolute',
    left: COMPOSER_PILL_GAP + COMPOSER_CONTROL_SIZE + COMPOSER_PILL_GAP,
    top: PILL_FIELD_TOP,
    // Over the action row, whose leading side would otherwise take the field's taps.
    zIndex: 1
  },
  pillActionRow: { marginTop: 0 },
  leadingExtras: { flex: 1, minWidth: 0 },
  leadingExtrasRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm
  },
  trailingControls: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  leadingControls: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm
  },
  // One line while dictating: a long computer name truncates instead of wrapping and growing the composer.
  dictationLeading: {
    flexWrap: 'nowrap'
  }
}))
