import { StyleSheet } from 'react-native'
import { colors, radii, spacing, textStyles, typography } from '../theme/mobile-theme'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'

// The sheet pads its content 12 pt; these offsets put groups 16 from the edge, as the pickers do,
// and let the shared section headers and banners keep their own 20 / 16 pt insets.
const GROUP_INSET = spacing.xs
const BLEED = -spacing.md

export const newWorktreeFormStyles = StyleSheet.create({
  header: { marginHorizontal: -spacing.sm, marginTop: -spacing.xs },
  bleed: { marginHorizontal: BLEED },
  unbleed: { paddingHorizontal: -BLEED },
  group: { marginHorizontal: GROUP_INSET },
  flush: { marginHorizontal: 0 },
  stack: { gap: spacing.lg, marginHorizontal: GROUP_INSET, marginTop: spacing.sm },
  bannerGap: { marginTop: spacing.md },
  bannerAfter: { marginBottom: spacing.md },
  errorGap: { marginTop: spacing.lg },
  state: { minHeight: 220 },
  optional: { ...textStyles.footnote, color: colors.textMuted },
  disabledRow: { opacity: 0.4 },
  repoDot: {
    width: 10,
    height: 10,
    borderRadius: radii.pill
  },
  // A text input laid out as a 52 pt list row, so the name reads as one of the form's rows.
  inputRow: {
    ...textStyles.body,
    fontSize: TEXT_INPUT_FONT_SIZE,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
    paddingVertical: 0,
    color: colors.textPrimary
  },
  // The bare icon buttons' 44 pt boxes reach into the row's padding so their glyphs line up.
  sourceActions: { flexDirection: 'row', alignItems: 'center', marginRight: -spacing.md },
  setupBlock: { gap: spacing.md, marginHorizontal: GROUP_INSET },
  codeBlock: {
    maxHeight: 168,
    borderRadius: radii.field,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.separator
  },
  codeContent: { padding: spacing.md },
  code: {
    fontFamily: typography.monoFamily,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textPrimary
  },
  footer: { marginTop: spacing.xl, marginHorizontal: GROUP_INSET }
})
