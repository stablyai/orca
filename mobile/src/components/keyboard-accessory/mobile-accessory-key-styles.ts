import { StyleSheet } from 'react-native'

import { colors, radii, spacing, typography } from '../../theme/mobile-theme'

// Why: single source of truth for the on-screen accessory keyboard styling shared
// by the terminal and browser tabs, so the two surfaces cannot drift apart again.
export const accessoryKeyStyles = StyleSheet.create({
  accessoryBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  accessoryScroll: {
    flex: 1,
    minWidth: 0
  },
  accessoryContent: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    gap: spacing.xs
  },
  accessoryKey: {
    backgroundColor: colors.bgRaised,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
    borderRadius: radii.button,
    minWidth: 36,
    alignItems: 'center'
  },
  accessoryKeyPressed: {
    backgroundColor: colors.borderSubtle
  },
  accessoryKeyActive: {
    backgroundColor: colors.textPrimary
  },
  customAccessoryKey: {
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  accessoryKeyDisabled: {
    opacity: 0.35
  },
  accessoryKeyText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontFamily: typography.monoFamily
  },
  accessoryKeyTextActive: {
    color: colors.bgBase,
    fontWeight: '700'
  },
  accessoryKeyTextDisabled: {
    color: colors.textMuted
  }
})
