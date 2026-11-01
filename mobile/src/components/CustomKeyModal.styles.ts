import { StyleSheet } from 'react-native'
import { colors, getMobileColorScheme, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const customKeyModalStyles = themedStyleSheet(() => ({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: spacing.sm
  },
  keyInput: {
    width: '100%',
    height: 56,
    borderRadius: radii.control,
    backgroundColor: colors.sheetGroup,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    // Keep 22px key capture above input floor; binding seam would lower it to 16px merely to satisfy census (C7 ruling 12).
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center'
  },
  backButton: {
    width: 30,
    height: 30,
    borderRadius: radii.control,
    alignItems: 'center',
    justifyContent: 'center'
  },
  backButtonPressed: {
    backgroundColor: colors.borderSubtle
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
    backgroundColor: colors.sheetGroup,
    borderRadius: radii.surface,
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
    backgroundColor: colors.borderSubtle
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
    borderRadius: radii.control,
    backgroundColor: colors.sheetGroup,
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
    borderRadius: radii.pill,
    backgroundColor: colors.sheetGroup,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4
  },
  chipSelected: {
    backgroundColor: colors.textPrimary
  },
  chipPressed: {
    backgroundColor: colors.borderSubtle
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
    color: getMobileColorScheme() === 'dark' ? 'rgba(10,10,10,0.5)' : 'rgba(255,255,255,0.5)'
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
    borderRadius: radii.control,
    backgroundColor: colors.sheetGroup,
    alignItems: 'center',
    justifyContent: 'center'
  },
  keyCellPressed: {
    backgroundColor: colors.borderSubtle
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
    borderRadius: radii.control,
    alignItems: 'center'
  },
  saveButtonDisabled: {
    backgroundColor: colors.borderSubtle
  },
  saveButtonText: {
    color: colors.bgBase,
    fontSize: 15,
    fontWeight: '600'
  },
  saveButtonTextDisabled: {
    color: colors.textMuted
  }
}))
