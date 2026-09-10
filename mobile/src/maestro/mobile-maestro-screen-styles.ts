import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export const mobileMaestroScreenStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  toolbar: {
    minHeight: 62,
    paddingHorizontal: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: colors.bgPanel,
    zIndex: 50
  },
  iconButton: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button
  },
  heading: { flex: 1, minWidth: 0, paddingLeft: spacing.xs },
  title: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.25
  },
  subtitle: { color: colors.textMuted, fontSize: typography.metaSize },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.xl,
    backgroundColor: colors.bgBase
  },
  centerText: {
    maxWidth: 360,
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    lineHeight: 21,
    textAlign: 'center'
  },
  errorTitle: { color: colors.statusRed, fontSize: typography.titleSize, fontWeight: '700' },
  emptyTitle: { color: colors.textPrimary, fontSize: typography.titleSize, fontWeight: '700' },
  retry: {
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  retryText: { color: colors.textPrimary, fontWeight: '600' },
  mutationError: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.statusRed,
    backgroundColor: colors.bgPanel,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  mutationErrorText: { flex: 1, color: colors.statusRed, fontSize: typography.metaSize },
  mutationErrorDismiss: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  workspaceBody: { flex: 1, flexDirection: 'row' },
  canvasArea: { flex: 1, minWidth: 0, overflow: 'hidden' },
  board: { flex: 1, overflow: 'hidden', backgroundColor: colors.bgBase }
})
