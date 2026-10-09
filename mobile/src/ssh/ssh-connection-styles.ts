import { Platform, StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export const sshConnectionStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase },
  header: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, gap: spacing.md },
  back: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.textPrimary, fontSize: typography.titleSize, fontWeight: '600', flex: 1 },
  form: { padding: spacing.lg, gap: spacing.sm },
  label: { color: colors.textSecondary, fontSize: typography.metaSize, marginTop: spacing.sm },
  help: { color: colors.textSecondary, fontSize: typography.bodySize, lineHeight: 20 },
  input: {
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.row,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 12 : 10
  },
  button: {
    padding: spacing.md,
    borderRadius: radii.button,
    backgroundColor: colors.surfaceBright,
    alignItems: 'center'
  },
  buttonText: { color: colors.bgBase, fontSize: typography.bodySize, fontWeight: '600' },
  secondary: { padding: spacing.md, alignItems: 'center' },
  secondaryText: { color: colors.textSecondary, fontSize: typography.bodySize },
  error: { color: colors.statusRed, fontSize: typography.bodySize },
  disabled: { opacity: 0.4 },
  profileName: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  profileDetail: { color: colors.textSecondary, fontSize: typography.metaSize, marginTop: 2 },
  inputPlaceholder: { color: colors.textSecondary, fontSize: typography.bodySize },
  segmented: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgBase,
    borderRadius: radii.button,
    padding: 2
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 6,
    borderRadius: radii.button - 1
  },
  segmentActive: { backgroundColor: colors.bgRaised },
  segmentText: { fontSize: typography.metaSize, color: colors.textSecondary, fontWeight: '600' },
  segmentTextActive: { color: colors.textPrimary }
})
