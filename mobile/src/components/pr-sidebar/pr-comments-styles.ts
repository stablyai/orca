import { StyleSheet } from 'react-native'
import { colors, radii, spacing, textStyles, typography } from '../../theme/mobile-theme'

// The PR description and the comment timeline: threads, cards, reactions.
export const prCommentsStyles = StyleSheet.create({
  noDescription: {
    ...textStyles.callout,
    color: colors.textMuted,
    flexShrink: 1
  },
  spinner: {
    alignSelf: 'flex-start'
  },
  failedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md
  },
  showMore: {
    alignSelf: 'center'
  },
  // A thread reads as one group: its comments sit inside it with hairlines between them.
  thread: {
    borderRadius: radii.group,
    backgroundColor: colors.bgPanel,
    overflow: 'hidden'
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.separator,
    marginLeft: spacing.lg + 28 + spacing.md
  },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xs,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm
  },
  // Replies sit under the root, indented by one avatar.
  reply: {
    paddingLeft: spacing.lg + 28 + spacing.md
  },
  main: {
    flex: 1,
    minWidth: 0
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    marginTop: -spacing.sm
  },
  headerText: {
    flex: 1,
    minWidth: 0,
    paddingTop: spacing.sm,
    gap: 1
  },
  authorLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  author: {
    ...textStyles.callout,
    fontWeight: '600',
    color: colors.textPrimary,
    flexShrink: 1
  },
  authorResolved: {
    color: colors.textSecondary
  },
  time: {
    ...textStyles.footnote,
    color: colors.textMuted,
    flexShrink: 0
  },
  path: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 16,
    fontFamily: typography.monoFamily
  },
  menuSlot: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center'
  },
  body: {
    paddingTop: spacing.xs,
    paddingRight: spacing.md
  },
  bodyResolved: {
    opacity: 0.7
  },
  reactionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginBottom: spacing.xs
  },
  reactionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 28,
    paddingHorizontal: 10,
    backgroundColor: colors.fill,
    borderRadius: radii.pill
  },
  reactionEmoji: {
    ...textStyles.footnote
  },
  reactionText: {
    ...textStyles.footnote,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums']
  },
  actionsRow: {
    flexDirection: 'row',
    marginLeft: -spacing.md
  },
  composer: {
    paddingTop: spacing.xs,
    paddingRight: spacing.md,
    paddingBottom: spacing.xs
  },
  actionError: {
    ...textStyles.subhead,
    color: colors.danger,
    paddingHorizontal: spacing.xs
  }
})
