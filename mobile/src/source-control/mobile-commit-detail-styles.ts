import { colors, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const commitDetailStyles = themedStyleSheet(() => ({
  message: { paddingTop: 14, paddingHorizontal: 20 },
  subject: { color: colors.textPrimary, fontSize: 22, lineHeight: 28, fontWeight: '600' },
  body: { color: colors.textSecondary, fontSize: 16, lineHeight: 23, marginTop: 10 },
  notice: {
    marginTop: 14,
    marginHorizontal: 20,
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18
  },
  noticeError: { color: colors.statusRed },
  launchNotice: { marginTop: 14, marginHorizontal: 20 },
  group: {
    marginTop: 22,
    marginHorizontal: 16,
    borderRadius: 16,
    backgroundColor: colors.bgPanel,
    overflow: 'hidden'
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingHorizontal: 16,
    gap: 12
  },
  detailDivider: { borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  detailLabel: { width: 76, color: colors.textPrimary, fontSize: 15, fontWeight: '500' },
  detailValue: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  detailText: { flexShrink: 1, color: colors.textSecondary, fontSize: 15 },
  mono: { fontFamily: typography.monoFamily },
  spacer: { flex: 1 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 22,
    paddingLeft: 7,
    paddingRight: 8,
    borderRadius: 11,
    overflow: 'hidden',
    backgroundColor: colors.bgRaised
  },
  badgeClear: { backgroundColor: 'transparent' },
  badgeUnpushedTint: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.accentBlue,
    opacity: 0.16
  },
  badgeDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.textMuted },
  badgeDotUnpushed: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: colors.accentBlue
  },
  badgeText: { color: colors.textSecondary, fontSize: 12, fontWeight: '500' },
  badgeTextUnpushed: { color: colors.accentBlue },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingTop: 26,
    paddingBottom: 8,
    paddingHorizontal: 20
  },
  sectionTitle: { color: colors.textMuted, fontSize: 13, lineHeight: 18, fontWeight: '500' },
  filesState: { alignItems: 'center', paddingVertical: 24, paddingHorizontal: 20, gap: 12 },
  stateText: { color: colors.textMuted, fontSize: 15, textAlign: 'center' },
  retryButton: {
    paddingHorizontal: 16,
    height: 36,
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: colors.bgRaised
  },
  retryText: { color: colors.textPrimary, fontSize: 15, fontWeight: '500' },
  treeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 44,
    paddingRight: 16,
    marginHorizontal: 16,
    backgroundColor: colors.bgPanel
  },
  treeFirst: { borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  treeLast: { borderBottomLeftRadius: 16, borderBottomRightRadius: 16 },
  treeDivider: { borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  treeRowPressed: { backgroundColor: colors.bgRaised },
  directoryName: { flex: 1, color: colors.textSecondary, fontSize: 14 },
  statusLetter: {
    width: 16,
    textAlign: 'center',
    fontFamily: typography.monoFamily,
    fontSize: 13,
    fontWeight: '600'
  },
  fileName: { flex: 1, minWidth: 0, color: colors.textPrimary, fontSize: 15 },
  fileNameDeleted: { color: colors.textSecondary, textDecorationLine: 'line-through' },
  dock: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 12,
    paddingHorizontal: 12,
    backgroundColor: colors.bgBase
  },
  primaryButton: {
    height: 50,
    borderRadius: 25,
    backgroundColor: colors.surfaceBright,
    alignItems: 'center',
    justifyContent: 'center'
  },
  primaryButtonText: { color: colors.bgBase, fontSize: 16, fontWeight: '600' },
  pressed: { opacity: 0.7 }
}))
