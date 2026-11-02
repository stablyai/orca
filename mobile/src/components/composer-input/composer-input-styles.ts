import { colors, feedback, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

/** Round controls on an action row: attach, mic, Send/Stop. */
export const COMPOSER_CONTROL_SIZE = 38
/** Grows a round control to a 44 pt touch box without crossing the action row's 8 pt gap. */
export const COMPOSER_CONTROL_HIT_SLOP = (44 - COMPOSER_CONTROL_SIZE) / 2
// Every input uses the composer's size, which also keeps the page above iOS's 16px focus-zoom floor.
export const COMPOSER_TEXT_SIZE = 16
export const COMPOSER_LINE_HEIGHT = 22
const MESSAGE_PADDING_VERTICAL = 2
export const MESSAGE_MIN_HEIGHT = 30
// A box with no controls is a form field: it opens a few lines tall so it reads as room to write.
export const FORM_MESSAGE_MIN_HEIGHT = 3 * COMPOSER_LINE_HEIGHT + 2 * MESSAGE_PADDING_VERTICAL
export const MESSAGE_MAX_HEIGHT = 7 * COMPOSER_LINE_HEIGHT
export const FIELD_MIN_HEIGHT = 44

const pillControl = {
  borderRadius: radii.pill,
  alignItems: 'center',
  justifyContent: 'center'
} as const

const roundControl = {
  ...pillControl,
  width: COMPOSER_CONTROL_SIZE,
  height: COMPOSER_CONTROL_SIZE
} as const

const labelControl = {
  ...pillControl,
  flexShrink: 1,
  minWidth: COMPOSER_CONTROL_SIZE,
  minHeight: COMPOSER_CONTROL_SIZE
} as const

// A field with no controls of its own is told apart by its edge alone, so it draws inputBorder (3:1).
const edge = (borderColor: string) =>
  ({ borderWidth: 1, borderColor, backgroundColor: colors.composerSurface }) as const

// The box owns the focus ring, so the browser's own ring on the text inside is dropped.
const noOwnRing = { outlineWidth: 0 } as const

// The chat composer's look, shared by every text input so they cannot drift apart; plain fields add the edge.
export const composerInputStyles = themedStyleSheet(() => ({
  box: {
    ...edge(colors.composerBorder),
    padding: spacing.md,
    borderRadius: radii.floating
  },
  formBox: {
    borderColor: colors.inputBorder,
    borderRadius: radii.surface
  },
  // The edge thickens to a 2pt accent ring, drawn as an outline so nothing moves.
  focused: {
    borderColor: colors.accentBlue,
    outlineColor: colors.accentBlue,
    outlineStyle: 'solid',
    outlineWidth: 1
  },
  fieldInput: {
    ...edge(colors.inputBorder),
    borderRadius: radii.control,
    color: colors.textPrimary
  },
  inlineBox: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.xs,
    borderRadius: radii.pill,
    paddingVertical: spacing.xs,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs
  },
  inlineText: {
    flex: 1,
    paddingVertical: (COMPOSER_CONTROL_SIZE - MESSAGE_MIN_HEIGHT) / 2
  },
  inlineActions: {
    marginTop: 0
  },
  formText: {
    ...noOwnRing,
    minHeight: FORM_MESSAGE_MIN_HEIGHT
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
    marginTop: spacing.sm,
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
  // Save and Cancel hug their translated label and truncate only when the row runs out.
  sendLabelButton: {
    ...labelControl,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surfaceBright
  },
  // Unframed, so a small inset is enough and leaves a long label more room.
  ghostLabelButton: {
    ...labelControl,
    paddingHorizontal: spacing.xs
  },
  pressed: {
    opacity: feedback.pressedOpacity
  },
  field: {
    ...edge(colors.inputBorder),
    minHeight: FIELD_MIN_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radii.control,
    paddingHorizontal: spacing.md
  },
  fieldText: {
    ...noOwnRing,
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
    opacity: feedback.disabledOpacity
  }
}))
