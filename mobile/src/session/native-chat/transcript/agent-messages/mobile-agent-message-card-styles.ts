import { radii, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'

export const stylesSheet = themedStyleSheet((colors) => ({
  compactCard: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.surface,
    backgroundColor: colors.chatPanel
  },
  meta: { color: colors.textMuted, fontSize: typography.metaSize, flexShrink: 1 },
  senders: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  sender: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  queuedSenders: { flexWrap: 'nowrap', alignItems: 'center', maxWidth: '100%' },
  queuedSender: { minWidth: 0, flexShrink: 1 },
  queuedLead: { flexShrink: 0 },
  queuedMeta: { color: colors.textSecondary },
  queuedComma: { flexShrink: 0, marginLeft: -spacing.xs },
  queuedOpenableName: { color: colors.textPrimary },
  name: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600',
    flexShrink: 1
  }
}))
