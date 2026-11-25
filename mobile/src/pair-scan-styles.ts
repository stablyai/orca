import { StyleSheet } from 'react-native'
import { colors, spacing, radii, typography } from '../src/theme/mobile-theme'
import { themedStyleSheet } from '../src/theme/themed-styles'

/** Text and glyphs over the camera, which stays dark in both themes. */
export const CAMERA_INK = '#ffffff'

export const pairScanStyles = themedStyleSheet(() => ({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  // Full bleed under the bar; black while the camera starts or sits paused behind the paste sheet.
  camera: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: '#000000'
  },
  cameraFoot: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    gap: spacing.lg,
    paddingTop: spacing.xl * 2,
    paddingHorizontal: spacing.xl
  },
  cameraHint: {
    color: CAMERA_INK,
    fontSize: 15,
    fontWeight: '500',
    textAlign: 'center'
  },
  cameraPaste: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 44,
    paddingHorizontal: 20,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(255, 255, 255, 0.16)'
  },
  cameraPasteLabel: {
    color: CAMERA_INK,
    fontSize: 15,
    fontWeight: '600'
  },
  reticle: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  reticleFrame: {
    position: 'relative'
  },
  corner: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderColor: 'rgba(255,255,255,0.7)'
  },
  cornerTL: {
    top: 0,
    left: 0,
    borderTopWidth: 2.5,
    borderLeftWidth: 2.5,
    borderTopLeftRadius: radii.mark
  },
  cornerTR: {
    top: 0,
    right: 0,
    borderTopWidth: 2.5,
    borderRightWidth: 2.5,
    borderTopRightRadius: radii.mark
  },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 2.5,
    borderLeftWidth: 2.5,
    borderBottomLeftRadius: radii.mark
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 2.5,
    borderRightWidth: 2.5,
    borderBottomRightRadius: radii.mark
  },
  scrollFill: { flexGrow: 1 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  connectingText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    marginTop: spacing.lg
  }
}))
