import { StyleSheet } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'

export const voiceProviderStyles = StyleSheet.create({
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.xl
  },
  heroText: { flex: 1, minWidth: 0 },
  heroTitle: { fontSize: 20, fontWeight: '700', color: colors.textPrimary },
  heroDescription: {
    fontSize: typography.metaSize + 1,
    lineHeight: 18,
    color: colors.textSecondary,
    marginTop: 2
  },
  maskedKey: {
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    fontFamily: typography.monoFamily,
    marginTop: 2,
    letterSpacing: 0.5
  },
  destructiveLabel: { color: colors.statusRed },
  testFailure: { fontSize: typography.metaSize, color: colors.statusRed, marginTop: 2 },
  testFailedTag: { color: colors.statusRed, fontSize: typography.metaSize, fontWeight: '600' }
})
