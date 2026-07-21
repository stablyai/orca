import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  backButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel
  },
  headerIcon: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  headerText: {
    flex: 1,
    gap: 3
  },
  title: {
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '700'
  },
  hostLine: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  subtitle: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  controls: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  searchInput: {
    height: 40,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.input,
    backgroundColor: colors.bgPanel,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    fontSize: typography.bodySize
  },
  chips: {
    gap: spacing.sm
  },
  chip: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  chipActive: {
    borderColor: colors.accentBlue,
    backgroundColor: colors.bgRaised
  },
  chipText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  chipTextActive: {
    color: colors.textPrimary
  },
  inlineError: {
    color: colors.statusRed,
    fontSize: typography.metaSize,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md
  },
  body: {
    flex: 1
  },
  bodyContent: {
    flexGrow: 1,
    gap: spacing.lg,
    padding: spacing.lg
  },
  centerState: {
    flex: 1,
    minHeight: 320,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md
  },
  centerText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    textAlign: 'center'
  },
  reconnectButton: {
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm
  },
  reconnectText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  group: {
    gap: spacing.sm
  },
  groupLabel: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontWeight: '700',
    textTransform: 'uppercase'
  },
  groupRows: {
    gap: spacing.sm
  }
})
