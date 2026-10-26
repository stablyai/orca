import { StyleSheet } from 'react-native'
import { colors, radii, spacing } from '../../../theme/mobile-theme'

/** Round controls on the action row: the attach button, the mic and Send/Stop. */
const COMPOSER_CONTROL_SIZE = 38
/** Space above the composer box; the queue box above reaches through it. */
export const COMPOSER_INSET_TOP = 6

const roundControl = {
  width: COMPOSER_CONTROL_SIZE,
  height: COMPOSER_CONTROL_SIZE,
  borderRadius: COMPOSER_CONTROL_SIZE / 2,
  alignItems: 'center',
  justifyContent: 'center'
} as const

export const mobileNativeChatComposerStyles = StyleSheet.create({
  composerInset: {
    paddingHorizontal: 10,
    paddingTop: COMPOSER_INSET_TOP,
    paddingBottom: spacing.sm
  },
  bar: {
    paddingTop: spacing.md,
    paddingHorizontal: 10,
    paddingBottom: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.composerBorder,
    borderRadius: radii.composer,
    backgroundColor: colors.composerSurface,
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 15,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8
  },
  actionRow: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  actionSpacer: {
    flex: 1
  },
  controlButton: {
    ...roundControl,
    backgroundColor: colors.composerControl
  },
  ghostButton: {
    ...roundControl
  },
  sendButton: {
    ...roundControl,
    backgroundColor: colors.surfaceBright
  },
  sendButtonDisabled: {
    backgroundColor: colors.composerControl
  },
  pressed: {
    opacity: 0.7
  }
})
