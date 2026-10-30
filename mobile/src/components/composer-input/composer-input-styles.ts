import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

/** Round controls on an action row: attach, mic, Send/Stop. */
export const COMPOSER_CONTROL_SIZE = 38
// Every input uses the composer's size, which also keeps the page above iOS's 16px focus-zoom floor.
export const COMPOSER_TEXT_SIZE = 16
export const COMPOSER_LINE_HEIGHT = 22
const MESSAGE_PADDING_VERTICAL = 2
export const MESSAGE_MIN_HEIGHT = 30
// A box with no controls is a form field: it opens a few lines tall so it reads as room to write.
export const FORM_MESSAGE_MIN_HEIGHT = 3 * COMPOSER_LINE_HEIGHT + 2 * MESSAGE_PADDING_VERTICAL
export const MESSAGE_MAX_HEIGHT = 7 * COMPOSER_LINE_HEIGHT
export const FIELD_MIN_HEIGHT = 44

const roundControl = {
  width: COMPOSER_CONTROL_SIZE,
  height: COMPOSER_CONTROL_SIZE,
  borderRadius: COMPOSER_CONTROL_SIZE / 2,
  alignItems: 'center',
  justifyContent: 'center'
} as const

const surface = () =>
  ({
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.composerBorder,
    backgroundColor: colors.composerSurface
  }) as const

// The chat composer's look, shared by every text input so they cannot drift apart.
export const composerInputStyles = themedStyleSheet(() => ({
  box: {
    ...surface(),
    paddingTop: spacing.md,
    paddingHorizontal: 10,
    paddingBottom: 10,
    borderRadius: radii.composer
  },
  formBox: {
    paddingTop: 10,
    borderRadius: radii.composerItem
  },
  formText: {
    minHeight: FORM_MESSAGE_MIN_HEIGHT
  },
  // Only bars floating over content cast a shadow; an inline box would shade its own thread.
  docked: {
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 15,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8
  },
  messageText: {
    width: '100%',
    minHeight: MESSAGE_MIN_HEIGHT,
    maxHeight: MESSAGE_MAX_HEIGHT,
    fontSize: COMPOSER_TEXT_SIZE,
    lineHeight: COMPOSER_LINE_HEIGHT,
    color: colors.textPrimary,
    paddingHorizontal: 6,
    paddingTop: MESSAGE_PADDING_VERTICAL,
    paddingBottom: MESSAGE_PADDING_VERTICAL
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
  },
  field: {
    ...surface(),
    minHeight: FIELD_MIN_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radii.composerItem,
    paddingHorizontal: spacing.md
  },
  fieldText: {
    flex: 1,
    minWidth: 0,
    alignSelf: 'stretch',
    padding: 0,
    margin: 0,
    fontSize: COMPOSER_TEXT_SIZE,
    color: colors.textPrimary,
    includeFontPadding: false,
    textAlignVertical: 'center'
  },
  mono: {
    fontFamily: typography.monoFamily
  },
  hiddenText: {
    color: 'transparent'
  },
  disabled: {
    opacity: 0.5
  }
}))
