import { feedback, radii, spacing, typography, type MobilePalette } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

/** Round controls on an action row: attach, mic, Send/Stop. */
export const COMPOSER_CONTROL_SIZE = 38
/** Grows a round control to a 44 pt touch box without crossing the action row's 8 pt gap. */
export const COMPOSER_CONTROL_HIT_SLOP = (44 - COMPOSER_CONTROL_SIZE) / 2
/** A round control in a one-line box: one 20pt text line plus its 4pt insets. */
export const COMPOSER_COMPACT_CONTROL_SIZE = 28
export const COMPOSER_COMPACT_CONTROL_HIT_SLOP = (44 - COMPOSER_COMPACT_CONTROL_SIZE) / 2
// Every input uses the composer's size, which also keeps the page above iOS's 16px focus-zoom floor.
export const COMPOSER_TEXT_SIZE = 16
export const COMPOSER_LINE_HEIGHT = 22
const MESSAGE_PADDING_VERTICAL = 2
export const MESSAGE_MIN_HEIGHT = 30
/** The message text's height for this many lines, its own padding included. */
export const linesHeight = (lines: number) =>
  lines * COMPOSER_LINE_HEIGHT + 2 * MESSAGE_PADDING_VERTICAL
// A box with no controls is a form field: it opens a few lines tall so it reads as room to write.
export const FORM_MESSAGE_MIN_HEIGHT = linesHeight(3)
export const MESSAGE_MAX_HEIGHT = 7 * COMPOSER_LINE_HEIGHT
export const FIELD_MIN_HEIGHT = 44
/** A field is a row of a grouped list: ListRow's height, its text on the row's 16 pt inset. */
export const FIELD_ROW_HEIGHT = 48
const FIELD_ROW_INSET = spacing.lg
// The message text pads itself 6 across and 2 down; its first line sits where a one-line row's does.
const FIELD_ROWS_PADDING = {
  paddingHorizontal: FIELD_ROW_INSET - 6,
  paddingVertical: (FIELD_ROW_HEIGHT - COMPOSER_LINE_HEIGHT) / 2 - MESSAGE_PADDING_VERTICAL
} as const

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

// A field on its own is a group of one: the group's fill and radius, no edge, so it matches the rows around it.
// A function, so the fill is read per theme inside the themed sheet.
const groupOfOne = (colors: MobilePalette) =>
  ({
    borderWidth: 0,
    borderRadius: radii.surface,
    backgroundColor: colors.sheetGroup
  }) as const

// The caret is the only focus sign, so the browser's own ring is dropped.
const noOwnRing = { outlineWidth: 0 } as const

// The chat composer's look, shared by every text input so they cannot drift apart; plain fields are grouped rows.
export const composerInputStylesSheet = themedStyleSheet((colors) => ({
  box: {
    borderWidth: 1,
    borderColor: colors.composerBorder,
    backgroundColor: colors.composerSurface,
    padding: spacing.md,
    borderRadius: radii.floating
  },
  formBox: {
    ...groupOfOne(colors),
    ...FIELD_ROWS_PADDING
  },
  fieldInput: {
    ...groupOfOne(colors),
    ...noOwnRing,
    fontSize: COMPOSER_TEXT_SIZE,
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
  compactSendButton: {
    width: COMPOSER_COMPACT_CONTROL_SIZE,
    height: COMPOSER_COMPACT_CONTROL_SIZE
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
    ...groupOfOne(colors),
    minHeight: FIELD_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: FIELD_ROW_INSET
  },
  // Off a sheet (a page, card, dock or toolbar) the group's fill would vanish in light, so a field there
  // takes the translucent grey that reads on any surface; search always does, as iOS draws it.
  filledFill: {
    backgroundColor: colors.translucentFill
  },
  filledField: {
    minHeight: FIELD_MIN_HEIGHT,
    borderRadius: radii.control,
    backgroundColor: colors.translucentFill,
    paddingHorizontal: spacing.md
  },
  fieldText: {
    ...noOwnRing,
    // On web an unpositioned input paints under TextField's absolute focus backdrop.
    position: 'relative',
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
  // A labelled field reads like a ListRow: the label where its title sits, the text after it.
  labelledField: {
    gap: spacing.md
  },
  fieldLabel: {
    minWidth: 72,
    color: colors.textPrimary,
    fontSize: 15
  },
  mono: {
    fontFamily: typography.monoFamily
  },
  disabled: {
    opacity: feedback.disabledOpacity
  }
}))

// A field inside a ListGroup: the group draws the fill, radius and hairlines, so the field draws none.
const unframed = {
  borderWidth: 0,
  borderRadius: 0,
  backgroundColor: 'transparent'
} as const

export const groupFieldStylesSheet = themedStyleSheet(() => ({
  line: { ...unframed, minHeight: FIELD_ROW_HEIGHT, paddingHorizontal: FIELD_ROW_INSET },
  lines: { ...unframed, ...FIELD_ROWS_PADDING },
  // A form's first group under its SheetHeader.
  underHeader: { marginTop: spacing.sm }
}))
