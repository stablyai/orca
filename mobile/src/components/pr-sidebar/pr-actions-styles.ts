import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'

// Styles for PRActionsSection (merge-method picker, action buttons, auto-merge
// toggle, transient-error line). Split out of mobile-pr-sidebar-styles to keep
// that file under the 300-line cap.
export const prActionsStyles = StyleSheet.create({
  // Merge-method selector: three segmented buttons; the chosen one highlights.
  methodRow: {
    flexDirection: 'row',
    gap: spacing.xs
  },
  methodButton: {
    flex: 1,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xs,
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  methodButtonSelected: {
    borderColor: colors.textSecondary,
    backgroundColor: colors.bgRaised
  },
  methodButtonText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '700'
  },
  methodButtonTextSelected: {
    color: colors.textPrimary
  },
  // Primary CTA (merge) and secondary action buttons (close/reopen/rerun/add).
  actionButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  // Neutral primary: a light fill with dark text, mirroring the desktop PR page's
  // default button (no bright accent) so the sidebar stays mostly monochrome.
  actionButtonPrimary: {
    backgroundColor: colors.textPrimary,
    borderColor: colors.textPrimary
  },
  // Merge CTA: green fill + white text, matching the desktop ChecksPanel's
  // bg-green-600 "Squash and merge". The merge still confirms before firing.
  actionButtonMerge: {
    backgroundColor: colors.mergeGreen,
    borderColor: colors.mergeGreen
  },
  actionButtonTextMerge: {
    color: colors.onMergeGreen
  },
  actionButtonDisabled: {
    opacity: 0.5
  },
  actionButtonText: {
    // Why: shrink + single-line (numberOfLines=1 at call sites) so a long label
    // like "Link existing pull request" can't wrap and inflate the button's
    // effective padding on a narrow sidebar.
    flexShrink: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  actionButtonTextPrimary: {
    color: colors.bgBase
  },
  actionButtonDestructiveText: {
    color: colors.statusRed
  },
  // Auto-merge toggle row: label + a pill that reflects on/off state.
  toggleRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  toggleLabel: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    flexShrink: 1
  },
  togglePill: {
    minWidth: 56,
    minHeight: 30,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  togglePillOn: {
    borderColor: colors.textSecondary,
    backgroundColor: colors.bgRaised
  },
  togglePillText: {
    fontSize: typography.metaSize,
    fontWeight: '700',
    color: colors.textSecondary
  },
  togglePillTextOn: {
    color: colors.textPrimary
  },
  // Non-blocking error line shown under an action after a transient failure.
  actionError: {
    color: colors.statusRed,
    fontSize: typography.metaSize,
    lineHeight: 18
  }
})
