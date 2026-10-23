import { StyleSheet } from 'react-native'
import { colors, radii, spacing, textStyles } from './theme/mobile-theme'

const CORNER_WIDTH = 3
const CORNER_RADIUS = 8

export const pairScanStyles = StyleSheet.create({
  steps: {
    gap: spacing.md,
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.lg
  },
  step: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md
  },
  stepBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.fill,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  },
  stepNumber: {
    ...textStyles.footnote,
    fontWeight: '600',
    color: colors.textPrimary,
    fontVariant: ['tabular-nums']
  },
  stepText: {
    ...textStyles.callout,
    color: colors.textSecondary,
    flex: 1,
    minWidth: 0
  },
  cameraWrap: {
    flex: 1,
    borderRadius: radii.group,
    overflow: 'hidden',
    backgroundColor: colors.bgPanel
  },
  // Why: holds the layout slot while the camera is unmounted during
  // paste, so the bottom action button doesn't snap up to fill the
  // empty space.
  cameraPlaceholder: {
    flex: 1,
    backgroundColor: colors.bgPanel,
    borderRadius: radii.group
  },
  camera: {
    ...StyleSheet.absoluteFillObject
  },
  reticle: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center'
  },
  reticleFrame: {
    position: 'relative'
  },
  corner: {
    position: 'absolute',
    width: 32,
    height: 32,
    borderColor: 'rgba(255, 255, 255, 0.85)'
  },
  cornerTL: {
    top: 0,
    left: 0,
    borderTopWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
    borderTopLeftRadius: CORNER_RADIUS
  },
  cornerTR: {
    top: 0,
    right: 0,
    borderTopWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
    borderTopRightRadius: CORNER_RADIUS
  },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
    borderBottomLeftRadius: CORNER_RADIUS
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
    borderBottomRightRadius: CORNER_RADIUS
  }
})
