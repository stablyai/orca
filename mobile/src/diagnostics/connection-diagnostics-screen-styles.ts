import { StyleSheet } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'

export const connectionDiagnosticsScreenStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase, padding: spacing.lg },
  topRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.lg },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm
  },
  heading: { fontSize: 20, fontWeight: '700', color: colors.textPrimary },
  hostPicker: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md
  },
  hostChip: {
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    borderRadius: 16,
    backgroundColor: colors.bgRaised
  },
  hostChipActive: {
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  hostChipText: { fontSize: typography.metaSize, color: colors.textSecondary, maxWidth: 160 },
  hostChipTextActive: { color: colors.textPrimary, fontWeight: '600' },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm
  },
  statusText: { fontSize: typography.metaSize, color: colors.textSecondary },
  diagnosisCard: {
    backgroundColor: colors.bgPanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: 10,
    padding: spacing.md,
    marginBottom: spacing.md
  },
  diagnosisHeading: {
    fontSize: typography.metaSize,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: spacing.xs
  },
  diagnosisText: { fontSize: typography.metaSize, color: colors.textPrimary, lineHeight: 18 },
  diagnosisNext: {
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    lineHeight: 18,
    marginTop: spacing.xs
  },
  privacyHint: { marginTop: spacing.sm, fontSize: 11, lineHeight: 15, color: colors.textMuted },
  sendButton: {
    marginTop: spacing.md,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: 8,
    backgroundColor: colors.bgRaised
  },
  sendButtonText: {
    fontSize: typography.metaSize,
    fontWeight: '600',
    color: colors.textPrimary
  },
  copyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    borderRadius: 8,
    backgroundColor: colors.bgRaised
  },
  copyButtonText: {
    fontSize: typography.metaSize,
    fontWeight: '600',
    color: colors.textPrimary
  },
  emptyText: { fontSize: typography.metaSize, color: colors.textMuted, lineHeight: 18 }
})
