import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export const hybridShellStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase },
  header: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  headerButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerCopy: { flex: 1, minWidth: 0 },
  heading: { color: colors.textPrimary, fontSize: 16, fontWeight: '600' },
  hostsButton: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  hostsButtonText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  webContainer: { flex: 1, minHeight: 0 },
  webView: { flex: 1, backgroundColor: colors.bgBase },
  noticeBanner: {
    gap: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md
  },
  noticeBannerText: { color: colors.textPrimary, fontSize: 13, lineHeight: 18 },
  noticeCode: { color: colors.textMuted, fontSize: 11 },
  recoveryActions: { alignItems: 'center', gap: spacing.md },
  recoveryActionsStart: { alignItems: 'flex-start' },
  recoveryPrimaryButton: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radii.button,
    backgroundColor: colors.textPrimary,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm
  },
  recoveryPrimaryButtonText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  recoveryLinkRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    columnGap: spacing.lg,
    rowGap: spacing.sm
  },
  recoveryLink: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  recoveryLinkText: {
    color: colors.accentBlue,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  recoveryPressed: { opacity: 0.7 },
  recoveryDisabled: { opacity: 0.5 },
  loadingState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl
  },
  loadingTitle: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600',
    textAlign: 'center'
  },
  packageProgress: { width: '100%', maxWidth: 320, gap: spacing.sm },
  // Above a live hosted page the bar reads as a banner: centered, on the panel surface,
  // separated from the page below instead of floating at the left edge.
  packageProgressBanner: {
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.bgPanel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  packageProgressLabel: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    textAlign: 'center'
  },
  packageProgressTrack: {
    height: 6,
    overflow: 'hidden',
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  packageProgressFill: {
    height: '100%',
    borderRadius: radii.button,
    backgroundColor: colors.textSecondary
  },
  packageProgressHint: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    textAlign: 'center'
  }
})
