import { StyleSheet } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    gap: spacing.sm
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center'
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center'
  },
  titleWrap: {
    flex: 1
  },
  heading: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary
  },
  subheading: {
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    marginTop: 1
  },
  list: {
    paddingTop: spacing.xs
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginLeft: spacing.lg
  },
  errorBanner: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm
  },
  errorText: {
    fontSize: typography.metaSize,
    color: colors.statusRed
  },
  placeholder: {
    paddingVertical: spacing.xl * 2,
    alignItems: 'center',
    gap: spacing.sm
  },
  placeholderText: {
    fontSize: typography.bodySize,
    color: colors.textSecondary
  }
})
