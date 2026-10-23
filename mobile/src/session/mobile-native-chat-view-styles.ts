import { StyleSheet } from 'react-native'
import { colors, spacing, textStyles } from '../theme/mobile-theme'

const FLOATING_CONTROLS_BOTTOM = spacing.md
const LOAD_EARLIER_HEIGHT = 44

export const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  banner: {
    paddingBottom: spacing.sm
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
    paddingVertical: spacing.sm
  },
  loadEarlierFailedText: {
    ...textStyles.footnote,
    flexShrink: 1,
    color: colors.textMuted,
    textAlign: 'center'
  }
})
