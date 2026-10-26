import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'

export const prAiTriageStyles = StyleSheet.create({
  triageArea: {
    gap: spacing.xs
  },
  // Match desktop failure-tinted triage strip: count summary and Fix action.
  triageStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.statusRed,
    backgroundColor: colors.diffDeletedBg
  },
  triageStripText: {
    flex: 1,
    minWidth: 0
  },
  triageStripTitle: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '700'
  },
  triageStripSubtitle: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  triageStripButton: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised
  },
  triageStripButtonText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '700'
  },
  triageButton: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised
  },
  triageButtonPressed: {
    opacity: 0.7
  },
  triageButtonText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  triageError: {
    color: colors.statusRed,
    fontSize: typography.metaSize
  }
})
