import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

/** Why: stretch compact buttons to a 44pt touch target without overlapping their neighbours. */
export const voiceCabinetHitSlop = {
  actionButton: { top: 7, bottom: 7 },
  // Why: 34pt + 10 each axis = 44pt; left stays within the rowActions gap so it never covers Use.
  iconButton: { top: 5, bottom: 5, left: 4, right: 6 },
  groupKeyButton: { top: 10, bottom: 10, left: 6, right: 6 }
} as const

/** Why: badges sit inline with the model title; past 1.5x Dynamic Type they push it off the row. */
export const VOICE_BADGE_MAX_FONT_SCALE = 1.5

// Provider-cabinet additions on top of voiceSettingsStyles (sections, rows, headings).
export const voiceCabinetStyles = StyleSheet.create({
  iconTile: {
    width: 32,
    height: 32,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowLabelShrink: { flexShrink: 1 },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.statusGreen },
  statusText: { fontSize: typography.metaSize, color: colors.textSecondary, flexShrink: 1 },
  statusTextMuted: { fontSize: typography.metaSize, color: colors.textMuted, flexShrink: 1 },
  inUseText: { fontSize: typography.metaSize, color: colors.textMuted },
  footnote: {
    fontSize: typography.metaSize - 1,
    lineHeight: 16,
    color: colors.textMuted,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.xs
  },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.textMuted
  },
  livePillText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.3,
    color: colors.textSecondary
  },
  recommended: { color: colors.statusGreen, fontSize: 10, fontWeight: '700' },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  modelRowDimmed: { opacity: 0.55 },
  modelInfo: { flex: 1, minWidth: 0 },
  modelLabel: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '500',
    flexShrink: 1
  },
  modelMeta: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    marginTop: 3,
    lineHeight: 16
  },
  modelMetaError: { color: colors.statusRed },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minHeight: 30,
    paddingHorizontal: spacing.md,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  actionPressed: { opacity: 0.7 },
  actionText: { color: colors.textSecondary, fontSize: typography.metaSize, fontWeight: '600' },
  iconButton: {
    width: 34,
    height: 34,
    borderRadius: radii.button,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  selectedTag: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  selectedText: { color: colors.statusGreen, fontSize: typography.metaSize, fontWeight: '600' },
  drawerSubtitle: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    paddingHorizontal: spacing.md + 2,
    paddingBottom: spacing.sm
  },
  drawerGroupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md + 2,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs
  },
  drawerGroupTitle: {
    flex: 1,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
    color: colors.textMuted
  },
  drawerGroupStatus: { fontSize: 11, color: colors.textMuted },
  groupKeyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  groupKeyButtonText: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  languageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.md + 2
  },
  languageLabel: { flex: 1, fontSize: typography.bodySize, color: colors.textPrimary },
  checkPlaceholder: { width: 18 },
  languageCode: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    marginRight: spacing.sm
  }
})
