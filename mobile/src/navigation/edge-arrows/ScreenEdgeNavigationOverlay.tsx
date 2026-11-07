import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AppState,
  Pressable,
  Text,
  View,
  type LayoutChangeEvent
} from 'react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { triggerSelection } from '../../platform/haptics'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { EdgeGamepadPad } from './EdgeGamepadPad'
import type { EdgeNavigationMode } from './edge-navigation-preference'
import { useGlobalEdgeNavigation } from './edge-navigation-state'
import type {
  EdgeDirection,
  EdgeNavigationPressHandle,
  EdgeNavigationTarget
} from './edge-navigation-context'
import { screenEdgeNavigationStyles as styles } from './screen-edge-navigation-styles'
import { useZoomStableViewport } from './use-zoom-stable-viewport'

const PANE_EDGE_INSET = 6
const EDGE_REPEAT_DELAY_MS = 400
const GAMEPAD_REPEAT_DELAY_MS = 260
const EDGE_REPEAT_INTERVAL_MS = 45

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function EdgeDirectionButton({
  direction,
  flavour,
  target,
  getPaneNode,
  positionStyle,
  sizeStyle,
  accessibilityLabel
}: {
  direction: EdgeDirection
  flavour: Exclude<EdgeNavigationMode, 'off'>
  target: EdgeNavigationTarget
  getPaneNode: () => unknown
  positionStyle: Record<string, number>
  sizeStyle?: Record<string, number>
  accessibilityLabel: string
}) {
  useMobileColorScheme()
  const pressRef = useRef<EdgeNavigationPressHandle | null>(null)
  const holdingRef = useRef(false)
  const suppressNextPressRef = useRef(false)
  const targetRef = useRef(target)
  targetRef.current = target

  const stopPress = useCallback(() => {
    holdingRef.current = false
    const active = pressRef.current
    pressRef.current = null
    active?.stop?.()
  }, [])

  useEffect(() => stopPress, [stopPress, target.id, flavour])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        stopPress()
      }
    })
    return () => subscription.remove()
  }, [stopPress])

  const enabled = target.canNavigate ? target.canNavigate(direction) : true
  const horizontalEdge = direction === 'up' || direction === 'down'

  const shapeStyle =
    flavour === 'pills'
      ? horizontalEdge
        ? styles.pillHorizontal
        : styles.pillVertical
      : flavour === 'strips'
        ? horizontalEdge
          ? styles.stripHorizontal
          : styles.stripVertical
        : flavour === 'gamepad'
          ? styles.gamepadDpadButton
          : styles.orb

  const glyphSize = flavour === 'strips' ? 7 : flavour === 'orbs' ? 9 : 8
  const glyphDirectionStyle =
    direction === 'up'
      ? styles.chevronUp
      : direction === 'down'
        ? styles.chevronDown
        : direction === 'left'
          ? styles.chevronLeft
          : styles.chevronRight

  const glyphColor = enabled ? colors.textPrimary : colors.textMuted
  const repeatDelayMs = flavour === 'gamepad' ? GAMEPAD_REPEAT_DELAY_MS : EDGE_REPEAT_DELAY_MS

  return (
    <Pressable
      testID={`edge-arrow-${direction}`}
      data-flavour={flavour}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={!enabled}
      delayLongPress={repeatDelayMs}
      hitSlop={flavour === 'strips' ? 12 : flavour === 'gamepad' ? 6 : 10}
      onPressIn={() => {
        if (!enabled) {
          return
        }
        if (flavour === 'gamepad') {
          triggerSelection()
        }
        stopPress()
        suppressNextPressRef.current = false
        holdingRef.current = false
        pressRef.current = targetRef.current.preparePress(direction, getPaneNode())
      }}
      onLongPress={() => {
        const handle = pressRef.current
        if (!enabled || !handle?.hold) {
          return
        }
        suppressNextPressRef.current = true
        holdingRef.current = true
        handle.hold(EDGE_REPEAT_INTERVAL_MS)
      }}
      onPressOut={() => {
        if (holdingRef.current) {
          stopPress()
        }
      }}
      onPress={() => {
        if (!enabled) {
          return
        }
        if (suppressNextPressRef.current || holdingRef.current) {
          suppressNextPressRef.current = false
          stopPress()
          return
        }
        const handle = pressRef.current
        pressRef.current = null
        void (handle ?? targetRef.current.preparePress(direction, getPaneNode())).tap()
      }}
      style={({ pressed }) => [
        styles.edgeControlBase,
        shapeStyle,
        sizeStyle,
        positionStyle,
        target.modifierActive && styles.edgeControlModifier,
        pressed && styles.edgeControlActive,
        pressed && styles.edgeControlPressed,
        !enabled && styles.edgeControlDisabled
      ]}
    >
      <View
        style={[
          styles.chevronGlyph,
          glyphDirectionStyle,
          { width: glyphSize, height: glyphSize, borderColor: glyphColor }
        ]}
      />
      {target.modifierActive && flavour !== 'gamepad' ? <View style={styles.modifierDot} /> : null}
    </Pressable>
  )
}

export function ScreenEdgeNavigationOverlay({
  target,
  bottomInset = 0,
  bottomRightOffset = 0
}: {
  target: EdgeNavigationTarget
  bottomInset?: number
  bottomRightOffset?: number
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const nav = useGlobalEdgeNavigation()
  const layerRef = useRef<View | null>(null)
  const [paneSize, setPaneSize] = useState({ width: 0, height: 0 })

  const getPaneNode = useCallback(() => layerRef.current, [])
  const safeBottomInset = Math.max(0, Math.round(bottomInset))
  const safeBottomRightOffset = Math.max(0, Math.round(bottomRightOffset))
  const fallbackWidth = paneSize.width > 0 ? paneSize.width : 390
  const fallbackHeight = paneSize.height > 0 ? paneSize.height : Math.max(140, 640 - safeBottomInset)
  const zoomMetrics = useZoomStableViewport(layerRef, fallbackWidth, fallbackHeight)

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = Math.round(event.nativeEvent.layout.width)
    const nextHeight = Math.round(event.nativeEvent.layout.height)
    setPaneSize((prev) =>
      prev.width === nextWidth && prev.height === nextHeight
        ? prev
        : { width: nextWidth, height: nextHeight }
    )
  }, [])

  if (!nav || nav.mode === 'off' || target.obscured) {
    return null
  }

  const { mode, switcherChipHidden, setSheetVisible, cycleMode } = nav
  const width = zoomMetrics.isZoomAdjusted ? zoomMetrics.width : fallbackWidth
  const height = zoomMetrics.isZoomAdjusted ? zoomMetrics.height : fallbackHeight

  const stripWidth = Math.round(clamp(width * 0.36, 96, 168))
  const stripHeight = Math.round(clamp(height * 0.32, 72, 144))

  const horizontalControlWidth = mode === 'strips' ? stripWidth : mode === 'orbs' ? 38 : 56
  const verticalControlHeight = mode === 'strips' ? stripHeight : mode === 'orbs' ? 38 : 56

  const centerX = Math.max(PANE_EDGE_INSET, Math.round((width - horizontalControlWidth) / 2))
  const minCenterY = PANE_EDGE_INSET + 28
  const maxCenterY = Math.max(minCenterY, height - PANE_EDGE_INSET - 36 - verticalControlHeight)
  const centerY = clamp(Math.round((height - verticalControlHeight) / 2), minCenterY, maxCenterY)

  // Avoid colliding with the bottom-center arrow on narrow split panes
  const narrowBottomCollision =
    mode !== 'gamepad' && centerX + horizontalControlWidth > width - 104
  const settingsDockBottom =
    PANE_EDGE_INSET + safeBottomRightOffset + (narrowBottomCollision ? 30 : 0)
  const gamepadRightClusterBottom = switcherChipHidden
    ? PANE_EDGE_INSET + 4 + safeBottomRightOffset
    : settingsDockBottom + 36

  const flavourShortLabel =
    mode === 'pills'
      ? t('navigation.edgeArrows.pillsShort', 'Pills')
      : mode === 'strips'
        ? t('navigation.edgeArrows.stripsShort', 'Strips')
        : mode === 'orbs'
          ? t('navigation.edgeArrows.orbsShort', 'Orbs')
          : t('navigation.edgeArrows.gamepadShort', 'Pad')

  const isTerminal = target.kind === 'terminal'
  const upLabel = isTerminal
    ? t('navigation.edgeArrows.terminalUp', 'Up arrow')
    : t('navigation.edgeArrows.navigateUp', 'Scroll up')
  const downLabel = isTerminal
    ? t('navigation.edgeArrows.terminalDown', 'Down arrow')
    : t('navigation.edgeArrows.navigateDown', 'Scroll down')
  const leftLabel = isTerminal
    ? t('navigation.edgeArrows.terminalLeft', 'Left arrow')
    : t('navigation.edgeArrows.previousTabOrBack', 'Previous tab or back')
  const rightLabel = isTerminal
    ? t('navigation.edgeArrows.terminalRight', 'Right arrow')
    : t('navigation.edgeArrows.nextTab', 'Next tab')

  return (
    <View
      ref={layerRef}
      testID="pane-edge-arrows-layer"
      pointerEvents="box-none"
      onLayout={handleLayout}
      style={[styles.layer, safeBottomInset > 0 ? { bottom: safeBottomInset } : undefined]}
    >
      <View
        testID="edge-arrows-zoom-hud"
        data-zoom-scale={zoomMetrics.scale}
        pointerEvents="box-none"
        style={
          zoomMetrics.isZoomAdjusted
            ? [
                styles.zoomHudCounterScaled,
                {
                  left: zoomMetrics.left,
                  top: zoomMetrics.top,
                  width: zoomMetrics.width,
                  height: zoomMetrics.height,
                  transform: [{ scale: zoomMetrics.inverseScale }]
                }
              ]
            : styles.zoomHudFill
        }
      >
        {mode === 'gamepad' ? (
          <EdgeGamepadPad
            target={target}
            getPaneNode={getPaneNode}
            bottomLeftOffset={PANE_EDGE_INSET + 4}
            bottomRightOffset={gamepadRightClusterBottom}
            upLabel={upLabel}
            downLabel={downLabel}
            leftLabel={leftLabel}
            rightLabel={rightLabel}
            renderDirectionButton={({ direction, positionStyle, accessibilityLabel }) => (
              <EdgeDirectionButton
                key={direction}
                direction={direction}
                flavour="gamepad"
                target={target}
                getPaneNode={getPaneNode}
                accessibilityLabel={accessibilityLabel}
                positionStyle={positionStyle}
              />
            )}
          />
        ) : (
          <>
            <EdgeDirectionButton
              direction="up"
              flavour={mode}
              target={target}
              getPaneNode={getPaneNode}
              accessibilityLabel={upLabel}
              sizeStyle={mode === 'strips' ? { width: stripWidth } : undefined}
              positionStyle={{ top: PANE_EDGE_INSET, left: centerX }}
            />
            <EdgeDirectionButton
              direction="down"
              flavour={mode}
              target={target}
              getPaneNode={getPaneNode}
              accessibilityLabel={downLabel}
              sizeStyle={mode === 'strips' ? { width: stripWidth } : undefined}
              positionStyle={{ bottom: PANE_EDGE_INSET, left: centerX }}
            />
            <EdgeDirectionButton
              direction="left"
              flavour={mode}
              target={target}
              getPaneNode={getPaneNode}
              accessibilityLabel={leftLabel}
              sizeStyle={mode === 'strips' ? { height: stripHeight } : undefined}
              positionStyle={{ top: centerY, left: PANE_EDGE_INSET }}
            />
            <EdgeDirectionButton
              direction="right"
              flavour={mode}
              target={target}
              getPaneNode={getPaneNode}
              accessibilityLabel={rightLabel}
              sizeStyle={mode === 'strips' ? { height: stripHeight } : undefined}
              positionStyle={{ top: centerY, right: PANE_EDGE_INSET }}
            />
          </>
        )}

        {!switcherChipHidden ? (
          <View
            testID="edge-arrow-settings-dock"
            pointerEvents="box-none"
            style={[
              styles.settingsDock,
              { bottom: settingsDockBottom, right: PANE_EDGE_INSET + 2 }
            ]}
          >
            <Pressable
              testID="edge-arrow-flavour-chip"
              accessibilityRole="button"
              accessibilityLabel={t(
                'navigation.edgeArrows.switchStyle',
                'Switch edge arrow style ({{style}})',
                { style: flavourShortLabel }
              )}
              hitSlop={8}
              onPress={() => {
                triggerSelection()
                cycleMode()
              }}
              onLongPress={() => {
                triggerSelection()
                setSheetVisible(true)
              }}
              style={({ pressed }) => [
                styles.flavourChip,
                pressed && styles.flavourChipPressed
              ]}
            >
              <View style={styles.flavourDot} />
              <Text style={styles.flavourChipText}>{flavourShortLabel}</Text>
            </Pressable>
            <Pressable
              testID="edge-arrow-settings-button"
              accessibilityRole="button"
              accessibilityLabel={t(
                'navigation.edgeArrows.openSettingsSheet',
                'Arrow keys & gamepad settings'
              )}
              hitSlop={8}
              onPress={() => {
                triggerSelection()
                setSheetVisible(true)
              }}
              style={({ pressed }) => [
                styles.settingsIconButton,
                pressed && styles.flavourChipPressed
              ]}
            >
              <Text style={styles.settingsGlyphText}>⚙</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  )
}
