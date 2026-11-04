import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'

export const styles = themedStyleSheet(() => ({
  compactCard: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.surface,
    backgroundColor: colors.bgPanel
  },
  compactHeader: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    minHeight: 44
  },
  headerToggle: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    borderRadius: radii.surface
  },
  compactHeading: { maxWidth: '45%', flexShrink: 0 },
  compactMultipleSenderHeading: { maxWidth: '25%' },
  compactSenderArrow: { flexShrink: 0 },
  compactMoreSenders: { flexShrink: 0 },
  compactSenders: { flex: 1, minWidth: 0, flexWrap: 'nowrap', alignItems: 'center' },
  compactSender: { minWidth: 0, flexShrink: 1, minHeight: 44 },
  compactAvatar: { width: 24, height: 24, borderRadius: 12 },
  compactBody: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm, gap: spacing.xs },
  refold: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  card: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.surface,
    backgroundColor: colors.bgPanel
  },
  content: { flex: 1, minWidth: 0, gap: spacing.xs },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  meta: { color: colors.textMuted, fontSize: typography.metaSize, flexShrink: 1 },
  senders: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  sender: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  name: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600',
    flexShrink: 1
  },
  toggle: { color: colors.textMuted, fontSize: typography.metaSize, paddingVertical: spacing.xs },
  body: { position: 'absolute', left: 0, right: 0, top: 0 },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  glyph: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    borderRadius: radii.pill,
    backgroundColor: colors.bgPanel
  }
}))
