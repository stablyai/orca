import { Platform, StyleSheet } from 'react-native'
import { colors, radii, spacing } from '../theme/mobile-theme'

export const bottomDrawerStyles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1000
  },
  root: {
    flex: 1
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)'
  },
  backdropPressable: {
    ...StyleSheet.absoluteFillObject
  },
  anchor: {
    flex: 1,
    justifyContent: 'flex-end'
  },
  anchorWide: {
    alignItems: 'center'
  },
  drawer: {
    backgroundColor: colors.sheet,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    paddingHorizontal: spacing.md,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -2 },
        shadowOpacity: 0.2,
        shadowRadius: 10
      },
      android: { elevation: 8 }
    })
  },
  drawerFill: {
    // Why: flex children (results + dock) need a column height budget; without
    // this, fill height alone still leaves staticContent height content-sized.
    overflow: 'hidden',
    flexDirection: 'column'
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: 'rgba(255, 255, 255, 0.26)'
  },
  handleHitArea: {
    alignItems: 'center',
    paddingTop: spacing.sm,
    paddingBottom: spacing.md
  },
  staticContent: {
    minHeight: 0
  },
  staticContentFill: {
    flex: 1
  },
  // Lets the drag wrapper give up height to the sheet's max, so its ScrollView scrolls.
  scrollFrame: {
    flexShrink: 1,
    minHeight: 0
  },
  bottomExtension: {
    position: 'absolute',
    bottom: -500,
    left: 0,
    right: 0,
    height: 500,
    backgroundColor: colors.sheet
  }
})
