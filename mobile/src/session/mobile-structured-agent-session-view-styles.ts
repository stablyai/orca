import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgBase },
  content: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, flexGrow: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  title: {
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '600',
    textAlign: 'center'
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: typography.bodySize,
    textAlign: 'center',
    marginTop: spacing.sm
  },
  loader: { paddingVertical: spacing.md },
  writeChrome: {
    alignItems: 'flex-end',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs
  },
  cancelButton: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  cancelText: { color: colors.statusRed, fontSize: typography.metaSize, fontWeight: '600' },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.45 },
  writeError: {
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm
  },
  writeErrorText: { color: colors.statusRed, fontSize: typography.metaSize },
  handoffBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs
  },
  handoffBanner: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgRaised,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  handoffError: { backgroundColor: colors.bgRaised },
  handoffText: { flex: 1, color: colors.textSecondary, fontSize: typography.metaSize },
  handoffErrorText: { flex: 1, color: colors.statusRed, fontSize: typography.metaSize },
  handoffButton: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  handoffButtonText: { color: colors.textPrimary, fontSize: typography.metaSize, fontWeight: '600' }
})
