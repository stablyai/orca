import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export const hostDirectoryBrowserStyles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm,
    gap: spacing.xs
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  title: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textPrimary
  },
  navActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  navButton: {
    padding: spacing.xs,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  currentPath: {
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily,
    color: colors.textMuted
  },
  searchInput: {
    backgroundColor: colors.bgPanel,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginVertical: spacing.xs
  },
  listContainer: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden',
    height: 260,
    marginVertical: spacing.xs
  },
  list: {
    flex: 1
  },
  centeredContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg
  },
  emptyText: {
    fontSize: typography.metaSize,
    color: colors.textMuted
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  entryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md
  },
  entryRowPressed: {
    backgroundColor: colors.bgRaised
  },
  entryRowDimmed: {
    opacity: 0.5
  },
  entryTextDirectory: {
    flex: 1,
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  entryTextFile: {
    flex: 1,
    fontSize: typography.bodySize,
    color: colors.textMuted
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.sm
  },
  kindToggle: {
    flexDirection: 'row',
    backgroundColor: colors.bgRaised,
    borderRadius: radii.button,
    padding: 2
  },
  kindButton: {
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    borderRadius: radii.button - 2
  },
  kindButtonActive: {
    backgroundColor: colors.borderSubtle
  },
  kindButtonText: {
    fontSize: typography.metaSize,
    fontWeight: '500',
    color: colors.textMuted
  },
  kindButtonTextActive: {
    color: colors.textPrimary
  },
  addButton: {
    flex: 1,
    backgroundColor: colors.surfaceBright,
    borderRadius: radii.button,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
    justifyContent: 'center'
  },
  addButtonText: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.bgBase
  },
  buttonDisabled: {
    opacity: 0.4
  },
  errorText: {
    fontSize: typography.metaSize,
    color: colors.statusRed,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.xs
  }
})
