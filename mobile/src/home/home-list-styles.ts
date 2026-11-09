import { StyleSheet } from 'react-native'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

// Text starts after the status column, so separators inset to it.
const STATUS_COLUMN_WIDTH = 24
const ROW_LEADING_PADDING = spacing.lg
/** Where a row's text starts: separators and nested rows line up with it. */
export const HOME_ROW_TEXT_INSET = ROW_LEADING_PADDING + STATUS_COLUMN_WIDTH
const TILE_SIZE = 30
const TILE_GAP = 11
const TILE_DOT_SIZE = 10
const TILE_DOT_RING = 2

/** Home's grouped lists: one inset group per section, a status column, a title and a wrapping detail line. */
export const homeListStyles = themedStyleSheet(() => ({
  sectionHeadingRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.xs,
    marginTop: 20,
    marginBottom: 7
  },
  sectionHeading: { flexShrink: 1, fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  sectionCount: { fontWeight: '500', color: colors.textMuted, fontVariant: ['tabular-nums'] },
  sectionAside: { fontSize: 14, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  sectionAsideRow: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  sectionLink: { color: colors.accentBlue, fontWeight: '500' },
  linkPressed: { opacity: 0.5 },
  firstSectionHeading: { marginTop: spacing.xs },
  // Matches a heading's top gap for a group that has none.
  headinglessGroup: { marginTop: 20 },
  group: { backgroundColor: colors.bgPanel, borderRadius: radii.surface, overflow: 'hidden' },
  search: { marginBottom: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingLeft: ROW_LEADING_PADDING },
  rowPressed: { backgroundColor: colors.bgRaised },
  rowDisabled: { opacity: 0.45 },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginLeft: HOME_ROW_TEXT_INSET
  },
  fullSeparator: { marginLeft: ROW_LEADING_PADDING },
  tileSeparator: { marginLeft: ROW_LEADING_PADDING + TILE_SIZE + TILE_GAP },
  status: {
    width: STATUS_COLUMN_WIDTH,
    height: 20,
    marginTop: 9,
    justifyContent: 'center'
  },
  // A machine tile in place of the status column, top-aligned with the title like it.
  tile: {
    width: TILE_SIZE,
    height: TILE_SIZE,
    marginTop: 9,
    marginRight: TILE_GAP,
    borderRadius: radii.tile,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  // The connection dot on the tile's corner, ringed in the group's colour.
  tileDot: {
    position: 'absolute',
    right: -3 - TILE_DOT_RING,
    bottom: -3 - TILE_DOT_RING,
    width: TILE_DOT_SIZE + TILE_DOT_RING * 2,
    height: TILE_DOT_SIZE + TILE_DOT_RING * 2,
    borderRadius: radii.pill,
    borderWidth: TILE_DOT_RING,
    borderColor: colors.bgPanel
  },
  text: { flex: 1, minWidth: 0, paddingVertical: 9 },
  title: { fontSize: 16, lineHeight: 20, color: colors.textPrimary },
  subtitle: { fontSize: 14, lineHeight: 18, color: colors.textSecondary, marginTop: 1 },
  detail: { fontSize: 14, lineHeight: 18, color: colors.textMuted, marginTop: 2 },
  // Centred on the whole row; the row itself top-aligns so the status column tracks the title.
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 6,
    paddingLeft: 10,
    paddingRight: 14
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
    paddingHorizontal: ROW_LEADING_PADDING
  },
  actionLabel: { fontSize: 16, color: colors.accentBlue },
  // A desktop's needs-you count, in the Feed badge's amber.
  countPill: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.statusAmber
  },
  countPillText: { fontSize: 12, fontWeight: '700', color: '#000', fontVariant: ['tabular-nums'] }
}))
