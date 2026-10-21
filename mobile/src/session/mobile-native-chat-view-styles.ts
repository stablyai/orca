import { StyleSheet } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'

const FLOATING_CONTROLS_BOTTOM = spacing.md
const TOOLS_PILL_HEIGHT = 32

export const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  sendError: {
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs
  },
  sendErrorText: {
    color: colors.statusRed,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  floatingControls: {
    position: 'absolute',
    right: spacing.md,
    bottom: FLOATING_CONTROLS_BOTTOM,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  toolsPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    height: TOOLS_PILL_HEIGHT,
    paddingHorizontal: spacing.md,
    borderRadius: TOOLS_PILL_HEIGHT / 2,
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  toolsPillLabel: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  pressed: {
    opacity: 0.6
  },
  listWrap: {
    flex: 1,
    position: 'relative'
  },
  listContent: {
    paddingVertical: spacing.sm,
    flexGrow: 1
  },
  // The last row can scroll clear of the floating status and Tools pills.
  listContentUnderFloatingControls: {
    paddingTop: spacing.sm,
    paddingBottom: FLOATING_CONTROLS_BOTTOM + TOOLS_PILL_HEIGHT + spacing.sm,
    flexGrow: 1
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl
  },
  emptyTitle: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: spacing.xs
  },
  emptySubtitle: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    textAlign: 'center'
  },
  fab: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  loadEarlier: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    minHeight: 36
  },
  loadEarlierText: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  loadEarlierFailedText: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    textAlign: 'center',
    marginTop: spacing.xs
  }
})
