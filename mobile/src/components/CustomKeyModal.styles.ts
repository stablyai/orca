import { StyleSheet } from 'react-native'
import { colors, spacing, radii, typography } from '../theme/mobile-theme'

export const customKeyModalStyles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: spacing.sm
  },
  backButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center'
  },
  backButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  backSpacer: {
    width: 30
  },
  title: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
    textAlign: 'center'
  },
  group: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden'
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  row: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  rowLabel: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary,
    marginBottom: 1
  },
  rowHint: {
    fontSize: 12,
    color: colors.textMuted
  },
  shortcutForm: {
    paddingTop: spacing.sm
  },
  preview: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg + spacing.xs,
    flexWrap: 'wrap'
  },
  previewKeycapRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  previewPlus: {
    color: colors.textMuted,
    fontSize: 16
  },
  keycap: {
    minWidth: 48,
    height: 48,
    paddingHorizontal: spacing.md,
    borderRadius: 10,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center'
  },
  keycapModifier: {
    minWidth: 0
  },
  keycapWarn: {
    borderColor: colors.statusAmber
  },
  keycapText: {
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: 17,
    fontWeight: '600'
  },
  keycapTextWarn: {
    color: colors.statusAmber
  },
  keycapModifierText: {
    color: colors.textSecondary,
    fontFamily: typography.monoFamily,
    fontSize: 14,
    fontWeight: '600'
  },
  section: {
    marginTop: spacing.md
  },
  sectionLabel: {
    fontSize: 11,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: spacing.sm,
    paddingLeft: 2
  },
  mods: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  chip: {
    flex: 1,
    height: 40,
    borderRadius: 8,
    backgroundColor: colors.bgPanel,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4
  },
  chipSelected: {
    backgroundColor: colors.textPrimary
  },
  chipPressed: {
    backgroundColor: colors.bgRaised
  },
  chipText: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: '500'
  },
  chipTextSelected: {
    color: colors.bgBase
  },
  chipGlyph: {
    color: colors.textMuted,
    fontSize: 13,
    fontFamily: typography.monoFamily
  },
  chipGlyphSelected: {
    color: 'rgba(10,10,10,0.5)'
  },
  keyInput: {
    width: '100%',
    height: 56,
    borderRadius: 10,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center'
  },
  moreLink: {
    paddingVertical: spacing.sm,
    alignItems: 'center'
  },
  moreLinkPressed: {
    opacity: 0.6
  },
  moreLinkText: {
    color: colors.textSecondary,
    fontSize: 13,
    textDecorationLine: 'underline'
  },
  specialKeysForm: {
    paddingTop: spacing.xs,
    paddingBottom: spacing.md,
    gap: spacing.md
  },
  specialGroup: {
    gap: spacing.xs
  },
  specialGroupTitle: {
    fontSize: 11,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingLeft: 2,
    marginBottom: spacing.xs
  },
  keyGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -spacing.xs / 2
  },
  keyCellWrap: {
    paddingHorizontal: spacing.xs / 2,
    paddingVertical: spacing.xs / 2
  },
  keyCell: {
    height: 40,
    borderRadius: 8,
    backgroundColor: colors.bgPanel,
    alignItems: 'center',
    justifyContent: 'center'
  },
  keyCellPressed: {
    backgroundColor: colors.bgRaised
  },
  keyCellSelected: {
    backgroundColor: colors.textPrimary
  },
  keyCellText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
    fontFamily: typography.monoFamily
  },
  keyCellTextSelected: {
    color: colors.bgBase
  },
  macroForm: {
    padding: spacing.md,
    gap: spacing.sm
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary
  },
  fieldInput: {
    backgroundColor: colors.bgBase,
    color: colors.textPrimary,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 14,
    fontFamily: typography.monoFamily,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs
  },
  switchLabel: {
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  saveButton: {
    marginTop: spacing.md,
    backgroundColor: colors.textPrimary,
    paddingVertical: spacing.md,
    borderRadius: 10,
    alignItems: 'center'
  },
  saveButtonDisabled: {
    backgroundColor: colors.bgRaised
  },
  saveButtonText: {
    color: colors.bgBase,
    fontSize: 15,
    fontWeight: '600'
  },
  saveButtonTextDisabled: {
    color: colors.textMuted
  }
})
