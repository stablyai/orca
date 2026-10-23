import { StyleSheet } from 'react-native'
import { colors, radii, spacing, textStyles } from '../theme/mobile-theme'
import { LIST_LEADING_INSET } from './ui/ListGroup'

// The sheet pads 12 pt; the list sits 4 further in (16 from the edge) as the form's groups do, and
// banners bleed back out to keep their own 16 pt inset.
const GROUP_INSET = spacing.xs

export const smartWorkspaceSourceDrawerStyles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0
  },
  header: {
    marginHorizontal: -spacing.sm,
    marginTop: -spacing.xs,
    flexShrink: 0
  },
  results: {
    flex: 1,
    minHeight: 0
  },
  banner: {
    marginHorizontal: -spacing.md,
    marginBottom: spacing.md
  },
  filterScroll: { flexGrow: 0, flexShrink: 0, marginBottom: spacing.xs },
  filterRow: { gap: spacing.sm, paddingHorizontal: GROUP_INSET },
  list: {
    flex: 1,
    marginHorizontal: GROUP_INSET,
    marginBottom: spacing.sm,
    backgroundColor: colors.groupFill,
    borderRadius: radii.group,
    overflow: 'hidden'
  },
  // With no rows the footer's message stands alone on the sheet, not in an empty card.
  listEmpty: { backgroundColor: 'transparent' },
  listContent: {
    flexGrow: 1
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.separator,
    marginLeft: LIST_LEADING_INSET
  },
  footerState: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: 64,
    paddingHorizontal: spacing.xl
  },
  footerText: { ...textStyles.callout, color: colors.textSecondary, textAlign: 'center' },
  // Why: pin the dock to the sheet bottom so a flex-greedy FlatList cannot
  // push the TextInput out of the fill frame (and under the keyboard).
  dock: {
    flexShrink: 0,
    marginHorizontal: -spacing.md,
    paddingHorizontal: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
    backgroundColor: colors.sheet,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.md,
    zIndex: 2
  },
  // Bleeds to the sheet edges so the segments scroll under them, not under a margin.
  modeRow: { paddingHorizontal: spacing.lg },
  modeScroll: { marginHorizontal: -spacing.lg, flexGrow: 0 }
})
