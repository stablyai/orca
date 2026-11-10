import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

// One rhythm for every cloud screen: 24 between sections, 8 from a heading to its card, 6 to a caption.
const SECTION_GAP = spacing.xl
const ACTION_BAR_HEIGHT = 50 + spacing.md * 2

/** Scroll padding that keeps the last row clear of the sticky action bar. */
export function cloudScrollBottomPadding(bottomInset: number): number {
  return ACTION_BAR_HEIGHT + Math.max(bottomInset, spacing.md) + spacing.lg
}

export const cloudWorkspaceScreenStyles = themedStyleSheet(() => ({
  container: { flex: 1, backgroundColor: colors.bgBase },
  flex: { flex: 1 },
  scroll: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md
  },
  emptyText: { fontSize: typography.bodySize, color: colors.textSecondary, textAlign: 'center' },
  linkButton: { minHeight: 44, minWidth: 44, padding: spacing.sm, justifyContent: 'center' },
  link: { fontSize: 16, color: colors.accentBlue, fontWeight: '500' },
  section: { marginTop: SECTION_GAP },
  sectionHeading: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xs
  },
  // The hairline keeps groups readable where the panel and page are nearly the same (light mode).
  card: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    overflow: 'hidden'
  },
  caption: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textMuted,
    marginTop: 6,
    paddingHorizontal: spacing.xs
  },
  statusCard: {
    backgroundColor: colors.bgPanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: radii.surface,
    padding: spacing.lg,
    gap: spacing.sm,
    marginTop: spacing.xs
  },
  statusHeadline: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  statusLabel: { flex: 1, fontSize: 20, fontWeight: '600', color: colors.textPrimary },
  statusLine: { fontSize: typography.bodySize, lineHeight: 20, color: colors.textSecondary },
  statusSpend: {
    fontSize: typography.bodySize,
    color: colors.textPrimary,
    fontVariant: ['tabular-nums']
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs,
    paddingVertical: spacing.xs,
    minHeight: 52,
    borderRadius: radii.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.statusRed,
    backgroundColor: colors.bgPanel
  },
  errorText: { flex: 1, fontSize: typography.bodySize, lineHeight: 20, color: colors.textPrimary },
  errorRetry: {
    minHeight: 36,
    marginVertical: 4,
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.inputBorder,
    justifyContent: 'center'
  },
  startedCard: {
    marginTop: spacing.sm,
    padding: spacing.lg,
    gap: spacing.sm,
    borderRadius: radii.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  startedHeadline: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  startedTitle: { flex: 1, fontSize: 16, fontWeight: '600', color: colors.textPrimary },
  startedAction: { alignSelf: 'flex-start' },
  detailDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginLeft: spacing.lg
  },
  errorRetryText: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  composerCard: {
    backgroundColor: colors.bgPanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: radii.surface,
    padding: spacing.md,
    gap: spacing.md
  },
  inputWrap: {
    backgroundColor: colors.bgRaised,
    borderRadius: radii.control,
    paddingLeft: spacing.md,
    paddingRight: 6,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm
  },
  input: {
    flex: 1,
    minHeight: 60,
    maxHeight: 180,
    fontSize: 16,
    lineHeight: 21,
    color: colors.textPrimary,
    paddingTop: 6,
    paddingBottom: 6,
    textAlignVertical: 'top'
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    backgroundColor: colors.textPrimary,
    alignItems: 'center',
    justifyContent: 'center'
  },
  sendPill: {
    height: 36,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.textPrimary,
    alignItems: 'center',
    justifyContent: 'center'
  },
  sendPillText: { fontSize: 14, fontWeight: '600', color: colors.bgBase },
  sendDisabled: {
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  sendDisabledText: { color: colors.textMuted },
  sendRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  pressed: { opacity: 0.7 },
  queueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm,
    paddingVertical: spacing.sm
  },
  queueRowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  queueNote: { alignItems: 'flex-start', paddingRight: spacing.lg },
  queueText: { flex: 1, gap: 2 },
  queuePrompt: { fontSize: 15, lineHeight: 20, color: colors.textPrimary },
  queueState: { fontSize: 13, lineHeight: 18, color: colors.textSecondary },
  queueStateFailed: { color: colors.statusRed },
  queueButtons: { flexDirection: 'row' },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  actionBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.bgBase,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  primary: {
    minHeight: 50,
    borderRadius: radii.control,
    backgroundColor: colors.textPrimary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg
  },
  primaryDisabled: { backgroundColor: colors.bgRaised },
  primaryText: { fontSize: 16, fontWeight: '600', color: colors.bgBase },
  primaryTextDisabled: { color: colors.textMuted },
  primaryElapsed: {
    fontSize: 15,
    color: colors.bgBase,
    opacity: 0.7,
    fontVariant: ['tabular-nums']
  }
}))
