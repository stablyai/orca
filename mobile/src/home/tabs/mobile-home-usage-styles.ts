import { StyleSheet } from 'react-native'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

const TILE_SIZE = 28
const METER_LABEL_WIDTH = 26
const METER_GAP = 10

export const mobileHomeUsageStyles = themedStyleSheet(() => ({
  screen: { flex: 1 },
  content: { paddingHorizontal: spacing.lg },
  loading: { alignItems: 'center', paddingVertical: 60 },
  card: { paddingVertical: 14, paddingHorizontal: spacing.lg, backgroundColor: colors.bgPanel },
  cardSeparated: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle },
  cardPressed: { backgroundColor: colors.bgRaised },
  head: { flexDirection: 'row', alignItems: 'center', gap: METER_GAP, marginBottom: 4 },
  tile: {
    width: TILE_SIZE,
    height: TILE_SIZE,
    borderRadius: radii.tile,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  headText: { flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 16, lineHeight: 22, color: colors.textPrimary },
  cardSubtitle: { fontSize: 13, lineHeight: 17, color: colors.textSecondary, marginTop: 1 },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.pill,
    backgroundColor: colors.skillTokenSurface
  },
  badgeText: { fontSize: 12, color: colors.accentBlue },
  meter: { flexDirection: 'row', alignItems: 'center', gap: METER_GAP, marginTop: 6 },
  meterLabel: { width: METER_LABEL_WIDTH, fontSize: 13, color: colors.textSecondary },
  track: {
    flex: 1,
    height: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.translucentFill,
    overflow: 'hidden'
  },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: radii.pill },
  meterValue: {
    width: 40,
    fontSize: 13,
    color: colors.textPrimary,
    textAlign: 'right',
    fontVariant: ['tabular-nums']
  },
  reset: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
    marginLeft: METER_LABEL_WIDTH + METER_GAP
  },
  empty: {
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: 28,
    marginTop: 32
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.textPrimary,
    marginTop: spacing.sm,
    marginBottom: spacing.xs
  },
  emptyBody: { fontSize: 15, lineHeight: 20, color: colors.textSecondary, textAlign: 'center' }
}))
