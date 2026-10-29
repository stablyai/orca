import { StyleSheet } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

const FLOATING_CONTROLS_BOTTOM = spacing.md
const LOAD_EARLIER_HEIGHT = 44
const LOAD_EARLIER_RETRY_HEIGHT = 28

export const styles = themedStyleSheet(() => ({
  hidden: { display: 'none' },
  root: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  inputLockStatus: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs
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
  listWrap: {
    flex: 1,
    position: 'relative'
  },
  listContent: {
    paddingVertical: spacing.sm,
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
    height: LOAD_EARLIER_HEIGHT
  },
  loadEarlierFailed: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md
  },
  loadEarlierRetry: {
    justifyContent: 'center',
    height: LOAD_EARLIER_RETRY_HEIGHT,
    paddingHorizontal: spacing.md,
    borderRadius: LOAD_EARLIER_RETRY_HEIGHT / 2,
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  loadEarlierRetryPressed: {
    opacity: 0.6
  },
  loadEarlierRetryLabel: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  loadEarlierFailedText: {
    flexShrink: 1,
    color: colors.textMuted,
    fontSize: typography.metaSize,
    textAlign: 'center'
  }
}))
