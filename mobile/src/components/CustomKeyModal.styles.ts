import { StyleSheet } from 'react-native'
import { colors, radii, spacing, textStyles, typography } from '../theme/mobile-theme'

export const customKeyModalStyles = StyleSheet.create({
  // Why: pulls the header's text actions out to the sheet edge, as the shared sheet spec lays them.
  header: { marginHorizontal: -spacing.sm, marginTop: -spacing.xs },
  // Why: the sheet already pads 12; these add 4 so content sits 16 from the sheet edge.
  group: { marginHorizontal: spacing.xs, marginBottom: spacing.sm },
  groupFlush: { marginHorizontal: 0 },
  form: { gap: spacing.lg, paddingHorizontal: spacing.xs, paddingBottom: spacing.sm },
  field: { gap: spacing.sm },
  fieldLabel: {
    ...textStyles.footnote,
    fontWeight: '500',
    color: colors.textSecondary,
    paddingLeft: 4
  },
  preview: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingVertical: spacing.lg
  },
  previewKeycapRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  previewPlus: { ...textStyles.body, color: colors.textMuted },
  keycap: {
    minWidth: 52,
    height: 52,
    paddingHorizontal: spacing.md,
    borderRadius: radii.field,
    backgroundColor: colors.fill,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    alignItems: 'center',
    justifyContent: 'center'
  },
  keycapModifier: { minWidth: 0 },
  keycapWarn: { borderColor: colors.statusAmber },
  keycapText: {
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: 20,
    fontWeight: '600'
  },
  keycapTextWarn: { color: colors.statusAmber },
  keycapModifierText: {
    color: colors.textSecondary,
    fontFamily: typography.monoFamily,
    fontSize: 15,
    fontWeight: '600'
  },
  mods: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  keyInput: {
    width: '100%',
    height: 56,
    borderRadius: radii.field,
    backgroundColor: colors.fieldFill,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    // 22 on both platforms, and no binding to the seam: the floor is the rule and this clears it,
    // so reading the seam here would have lowered a one-character capture field to 16 to satisfy
    // a census. C7 ruling 12.
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center'
  },
  keyInputFocused: { borderColor: colors.fieldBorderFocused },
  specialKeysForm: {
    // The section headers pad for a full-width screen; the sheet already pads 12.
    marginHorizontal: -spacing.md,
    paddingBottom: spacing.md
  },
  keyGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: spacing.lg - spacing.xs / 2
  },
  keyCellWrap: { padding: spacing.xs / 2 },
  keyCell: {
    height: 44,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: colors.fill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  keyCellPressed: { backgroundColor: colors.fillPressed },
  keyCellSelected: { backgroundColor: colors.fillPressed, borderColor: colors.fieldBorderFocused },
  keyCellText: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '600',
    color: colors.textPrimary,
    fontFamily: typography.monoFamily
  }
})
