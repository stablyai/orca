import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export const TEXT_SIZE = 17
export const MONO_SIZE = 12
export const MAX_TOOL_RESULT_CHARS = 4000

export const styles = StyleSheet.create({
  row: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm
  },
  rowUser: {
    alignItems: 'flex-end'
  },
  content: {
    maxWidth: '100%',
    gap: spacing.sm
  },
  userBubble: {
    maxWidth: '88%',
    backgroundColor: colors.textPrimary,
    borderRadius: radii.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  userText: {
    color: colors.bgBase,
    fontSize: TEXT_SIZE,
    lineHeight: TEXT_SIZE + 6,
    fontWeight: '500'
  },
  controls: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.xs,
    marginBottom: 2,
    opacity: 0.7
  },
  controlButton: {
    padding: 3
  },
  controlPressed: {
    opacity: 0.5
  },
  copied: {
    backgroundColor: colors.diffAddedBg,
    borderRadius: radii.card
  },
  reasoning: {
    opacity: 0.7
  },
  queued: {
    opacity: 0.55
  },
  queuedTag: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 2
  },
  toolRun: {
    marginTop: spacing.xs
  },
  toolRunHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  toolRunToggle: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 3
  },
  controlsRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end'
  },
  toolRunCount: {
    color: colors.statusGreen,
    fontFamily: typography.monoFamily,
    fontSize: MONO_SIZE,
    fontWeight: '700'
  },
  toolRunLabel: {
    flex: 1,
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    fontSize: MONO_SIZE
  },
  toolRunBody: {
    paddingLeft: spacing.sm,
    borderLeftWidth: 2,
    borderLeftColor: colors.borderSubtle,
    marginTop: spacing.xs
  },
  toolLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 3
  },
  toolName: {
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: MONO_SIZE + 1,
    fontWeight: '600'
  },
  toolPreview: {
    flex: 1,
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    fontSize: MONO_SIZE
  },
  toolPreviewLink: {
    color: colors.accentBlue,
    textDecorationLine: 'underline'
  },
  toolDetail: {
    paddingLeft: spacing.lg,
    paddingBottom: spacing.xs,
    gap: spacing.xs
  },
  mono: {
    color: colors.textSecondary,
    fontFamily: typography.monoFamily,
    fontSize: MONO_SIZE,
    lineHeight: MONO_SIZE + 5
  },
  toolResult: {
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel,
    padding: spacing.md
  },
  toolResultError: {
    backgroundColor: colors.diffDeletedBg
  },
  imageRef: {
    color: colors.textSecondary,
    fontSize: TEXT_SIZE
  },
  imageThumb: {
    width: 200,
    height: 150,
    borderRadius: radii.card,
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  diff: {
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel,
    paddingVertical: spacing.xs,
    overflow: 'hidden'
  },
  diffLine: {
    color: colors.textSecondary,
    fontFamily: typography.monoFamily,
    fontSize: MONO_SIZE,
    lineHeight: MONO_SIZE + 5,
    paddingHorizontal: spacing.sm
  },
  diffAdd: {
    color: colors.gitDecorationAdded,
    backgroundColor: colors.diffAddedBg
  },
  diffDel: {
    color: colors.gitDecorationDeleted,
    backgroundColor: colors.diffDeletedBg
  },
  diffMeta: {
    color: colors.textMuted
  }
})
