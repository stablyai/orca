import { StyleSheet } from 'react-native'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

// Text starts after the status column, so separators inset to it.
const STATUS_COLUMN_WIDTH = 24
const ROW_LEADING_PADDING = spacing.lg

/** Home's grouped lists: one inset group per section, a status column, a title and a wrapping detail line. */
export const homeListStyles = themedStyleSheet(() => ({
  sectionHeading: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
    paddingHorizontal: spacing.xs,
    marginTop: 26,
    marginBottom: 9
  },
  firstSectionHeading: { marginTop: spacing.sm },
  group: { backgroundColor: colors.bgPanel, borderRadius: radii.surface, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingLeft: ROW_LEADING_PADDING },
  rowPressed: { backgroundColor: colors.bgRaised },
  rowDisabled: { opacity: 0.45 },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginLeft: ROW_LEADING_PADDING + STATUS_COLUMN_WIDTH
  },
  fullSeparator: { marginLeft: ROW_LEADING_PADDING },
  status: {
    width: STATUS_COLUMN_WIDTH,
    height: 22,
    marginTop: 12,
    justifyContent: 'center'
  },
  // AgentSpinner's box, so connection dots and agent dots share one column.
  statusDotBox: { width: 12, alignItems: 'center' },
  text: { flex: 1, minWidth: 0, paddingVertical: 12 },
  title: { fontSize: 17, lineHeight: 22, color: colors.textPrimary },
  subtitle: { fontSize: 15, lineHeight: 20, color: colors.textSecondary, marginTop: 1 },
  detail: { fontSize: 15, lineHeight: 20, color: colors.textMuted, marginTop: 3 },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 22,
    marginTop: 12,
    paddingLeft: 10,
    paddingRight: 14
  },
  time: { fontSize: 15, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 52,
    paddingHorizontal: ROW_LEADING_PADDING
  },
  actionLabel: { fontSize: 17, color: colors.accentBlue }
}))
