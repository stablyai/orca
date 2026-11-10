import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

// The asleep workspace's read-only "Latest from this workspace" area; scheme-aware like every cloud card.
export const readSnapshotStyles = themedStyleSheet(() => ({
  asOf: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.textMuted,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xs
  },
  asOfButton: { alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' },
  stack: { gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: 52
  },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 15, lineHeight: 20, color: colors.textPrimary },
  rowMeta: { fontSize: 13, lineHeight: 18, color: colors.textSecondary },
  rowMetaAttention: { color: colors.statusAmber },
  mono: {
    fontFamily: typography.monoFamily,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textSecondary
  },
  added: { color: colors.gitDecorationAdded },
  removed: { color: colors.gitDecorationDeleted },
  gitBody: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: 6 },
  gitHeadline: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, flexWrap: 'wrap' },
  transcript: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.sm
  },
  truncatedNote: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
    paddingVertical: spacing.xs
  },
  roleLabel: { fontSize: 11, fontWeight: '600', color: colors.textMuted, marginBottom: 2 },
  bubbleUser: {
    alignSelf: 'flex-end',
    maxWidth: '88%',
    backgroundColor: colors.chatUserSurface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.chatUserBorder,
    borderRadius: radii.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  bubbleAssistant: {
    alignSelf: 'stretch',
    paddingHorizontal: spacing.xs,
    paddingVertical: 2
  },
  bubbleSystem: {
    alignSelf: 'stretch',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised
  },
  userText: { fontSize: 15, lineHeight: 21, color: colors.textPrimary },
  systemText: { fontSize: 13, lineHeight: 18, color: colors.textSecondary },
  notice: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md
  },
  noticeText: { fontSize: typography.bodySize, lineHeight: 20, color: colors.textSecondary },
  skeletonCard: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    padding: spacing.lg,
    gap: spacing.md
  },
  skeletonBar: { height: 10, borderRadius: 5, backgroundColor: colors.bgRaised }
}))
