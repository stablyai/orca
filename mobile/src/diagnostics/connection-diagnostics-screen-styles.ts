import { StyleSheet } from 'react-native'
import { colors, radii, spacing, textStyles } from '../theme/mobile-theme'

export const connectionDiagnosticsScreenStyles = StyleSheet.create({
  body: { flex: 1, paddingHorizontal: spacing.lg, gap: spacing.md },
  hostPicker: { flexGrow: 0, marginHorizontal: -spacing.lg },
  hostPickerContent: { paddingHorizontal: spacing.lg - 4, gap: spacing.xs },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: 4
  },
  statusText: {
    ...textStyles.callout,
    fontWeight: '500',
    color: colors.textPrimary,
    flex: 1,
    minWidth: 0
  },
  diagnosisCard: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.group,
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
    gap: spacing.xs
  },
  diagnosisHeading: { ...textStyles.footnote, fontWeight: '500', color: colors.textMuted },
  diagnosisText: { ...textStyles.callout, color: colors.textPrimary },
  diagnosisNext: { ...textStyles.subhead, color: colors.textSecondary },
  privacyHint: { ...textStyles.footnote, color: colors.textMuted, marginTop: spacing.sm },
  sendResult: { ...textStyles.footnote, marginTop: spacing.xs },
  sendAction: { marginTop: spacing.sm },
  empty: { flex: 1 }
})
