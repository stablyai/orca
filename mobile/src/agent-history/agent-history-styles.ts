import { StyleSheet } from 'react-native'
import { LIST_LEADING_INSET } from '../components/ui/ListGroup'
import { colors, radii, spacing, textStyles } from '../theme/mobile-theme'

const LEADING_SLOT = 28

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  header: {
    backgroundColor: colors.bgBase
  },
  controls: {
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm
  },
  notice: {
    // The Banner insets itself for full-width screens; here the controls already do.
    marginHorizontal: -spacing.lg,
    gap: spacing.sm
  },
  issueFrame: { marginTop: -spacing.sm },
  issueGap: { paddingTop: spacing.sm },
  issueList: {
    marginHorizontal: spacing.lg,
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.group,
    backgroundColor: colors.bgPanel
  },
  issueRow: { gap: 2 },
  issuePath: {
    ...textStyles.footnote,
    color: colors.textPrimary
  },
  issueMessage: {
    ...textStyles.footnote,
    color: colors.textSecondary
  },
  list: {
    paddingBottom: spacing.xl + spacing.lg
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: LIST_LEADING_INSET,
    backgroundColor: colors.separator
  },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md
  },
  rowPressed: {
    backgroundColor: colors.fill
  },
  leading: {
    width: LEADING_SLOT,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  },
  main: {
    flex: 1,
    minWidth: 0,
    gap: 3
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  title: {
    ...textStyles.body,
    fontWeight: '500',
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary
  },
  timeAgo: {
    ...textStyles.footnote,
    flexShrink: 0,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  },
  chevronCollapsed: { transform: [{ rotate: '0deg' }] },
  chevronExpanded: { transform: [{ rotate: '180deg' }] },
  lastMessage: {
    ...textStyles.callout,
    color: colors.textSecondary
  },
  badgeLine: { flexDirection: 'row', marginTop: 6 },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: 1
  },
  metaText: {
    ...textStyles.footnote,
    flexShrink: 1,
    minWidth: 0,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  },
  metaSpacer: { flex: 1 },
  resume: {
    // The compact button's 44 pt touch box overhangs its 36 pt pill; keep the row's rhythm.
    marginVertical: -4
  },
  preview: {
    marginTop: spacing.sm,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
    gap: spacing.md
  },
  previewTurn: { gap: 2 },
  previewRole: {
    ...textStyles.footnote,
    fontWeight: '500',
    color: colors.textMuted
  },
  previewText: {
    ...textStyles.callout,
    color: colors.textSecondary
  }
})
