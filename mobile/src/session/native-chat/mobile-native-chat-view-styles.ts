import { StyleSheet } from 'react-native'
import { feedback, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

const FLOATING_CONTROLS_BOTTOM = spacing.md
export const NATIVE_CHAT_FAB_SIZE = 38
export const NATIVE_CHAT_FAB_GAP = spacing.sm
const LOAD_EARLIER_HEIGHT = 44
const RETRY_PILL_HEIGHT = 28

export const stylesSheet = themedStyleSheet((colors) => ({
  hidden: { display: 'none' },
  root: {
    flex: 1,
    backgroundColor: colors.chatCanvas
  },
  inputLockStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs
  },
  inputLockStatus: {
    flexShrink: 1,
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  sendError: {
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs
  },
  sendErrorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  sendErrorText: {
    flexShrink: 1,
    color: colors.statusRed,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  floatingControls: {
    position: 'absolute',
    right: spacing.md,
    bottom: FLOATING_CONTROLS_BOTTOM,
    width: NATIVE_CHAT_FAB_SIZE,
    // Room for the previous-message button stacked on the jump-to-latest button.
    height: NATIVE_CHAT_FAB_SIZE * 2 + NATIVE_CHAT_FAB_GAP
  },
  listWrap: {
    flex: 1,
    position: 'relative'
  },
  // Clear of the edge fades at either end.
  listContent: {
    paddingVertical: spacing.lg,
    flexGrow: 1
  },
  fab: {
    width: NATIVE_CHAT_FAB_SIZE,
    height: NATIVE_CHAT_FAB_SIZE,
    borderRadius: radii.pill,
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
  retryPill: {
    justifyContent: 'center',
    height: RETRY_PILL_HEIGHT,
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  retryPillPressed: {
    opacity: feedback.pressedOpacity
  },
  retryPillLabel: {
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
