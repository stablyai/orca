import { StyleSheet } from 'react-native'
import { colors, radii, spacing, textStyles } from '../theme/mobile-theme'
import { LIST_ROW_PADDING } from '../components/ui/ListGroup'

export const troubleshootScreenStyles = StyleSheet.create({
  actions: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm
  },
  results: { marginTop: spacing.md },
  developer: { marginTop: spacing.sm },
  // The same inset group ListGroup draws, for rows the diagnostics build by hand.
  section: {
    marginHorizontal: spacing.lg,
    borderRadius: radii.group,
    backgroundColor: colors.bgPanel,
    overflow: 'hidden'
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.separator,
    marginLeft: LIST_ROW_PADDING
  },
  iconSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.separator,
    marginLeft: LIST_ROW_PADDING + 28 + spacing.md
  },
  sectionHeading: {
    ...textStyles.footnote,
    fontWeight: '500',
    color: colors.textMuted,
    paddingHorizontal: spacing.lg + 4,
    paddingTop: spacing.xl,
    paddingBottom: spacing.sm
  },
  checkRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: 14
  },
  checkIcon: { width: 28, alignItems: 'center', paddingTop: 2 },
  checkMain: { flex: 1, minWidth: 0, gap: 2 },
  checkLabel: { ...textStyles.body, fontWeight: '500', color: colors.textPrimary },
  checkDetail: { ...textStyles.subhead, color: colors.textSecondary },
  checkDetailFail: { color: colors.danger },
  disclosureRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: 10
  },
  rowPressed: { backgroundColor: colors.fill },
  disclosureIcon: { width: 28, alignItems: 'center' },
  disclosureTitle: { ...textStyles.body, flex: 1, minWidth: 0, color: colors.textPrimary },
  chevronCollapsed: { transform: [{ rotate: '0deg' }] },
  chevronExpanded: { transform: [{ rotate: '180deg' }] },
  disclosureBody: {
    paddingLeft: LIST_ROW_PADDING + 28 + spacing.md,
    paddingRight: LIST_ROW_PADDING,
    paddingBottom: spacing.lg,
    gap: spacing.sm
  },
  stepRow: { flexDirection: 'row', gap: spacing.sm },
  bullet: { ...textStyles.subhead, color: colors.textMuted },
  stepText: { ...textStyles.subhead, flex: 1, color: colors.textSecondary },
  noteBody: {
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: 14,
    gap: spacing.sm
  }
})
