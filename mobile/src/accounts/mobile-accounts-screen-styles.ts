import { StyleSheet } from 'react-native'
import { colors, motion, spacing, textStyles } from '../theme/mobile-theme'

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  scroll: {
    flexGrow: 1,
    paddingTop: spacing.xs
  },
  banner: {
    marginBottom: spacing.sm
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg + 4,
    paddingTop: spacing.xl,
    paddingBottom: spacing.sm
  },
  sectionHeaderFirst: {
    paddingTop: spacing.sm
  },
  sectionHeading: {
    ...textStyles.footnote,
    fontWeight: '500',
    color: colors.textMuted
  },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md
  },
  rowPressed: {
    backgroundColor: colors.fill
  },
  rowDisabled: {
    opacity: motion.disabledOpacity
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    gap: 2
  },
  rowTitle: {
    ...textStyles.body,
    fontWeight: '500',
    color: colors.textPrimary
  },
  rowSubtitle: {
    ...textStyles.subhead,
    color: colors.textSecondary
  },
  usageStack: {
    gap: spacing.md,
    marginTop: spacing.md
  },
  // Pinned to the title line, so the check names the account rather than its usage.
  rowTrailing: {
    width: 24,
    height: 23,
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  },
  errorText: {
    ...textStyles.footnote,
    marginTop: spacing.sm,
    color: colors.danger
  },
  footerHint: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg + 4,
    paddingTop: spacing.lg
  },
  footerIcon: {
    marginTop: 2
  },
  footerHintText: {
    ...textStyles.footnote,
    flex: 1,
    color: colors.textMuted
  }
})
