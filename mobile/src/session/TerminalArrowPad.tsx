import { useEffect, useRef, useState } from 'react'
import { View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { terminalDockStyles as styles } from './terminal-dock-styles'

export type TerminalArrowKey = 'arrowUp' | 'arrowDown' | 'arrowLeft' | 'arrowRight'

const DRAG_START_DISTANCE = 10

function directionOf(dx: number, dy: number): TerminalArrowKey {
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx < 0 ? 'arrowLeft' : 'arrowRight'
  }
  return dy < 0 ? 'arrowUp' : 'arrowDown'
}

// The pad is wider than tall, so compare against each half-size to split it into four even sides.
function sideAt(x: number, y: number, width: number, height: number): TerminalArrowKey {
  return directionOf((x - width / 2) / (width / 2), (y - height / 2) / (height / 2))
}

type Drag = {
  readonly x: number
  readonly y: number
  direction: TerminalArrowKey | null
}

// One key for all four arrows: tap a side for one press, or hold and drag to repeat.
export function TerminalArrowPad({
  onPressStart,
  onTap,
  onRepeatStart,
  onRepeatStop,
  onHoldChange,
  onAccessibilityArrow,
  disabled
}: {
  /** The finger landed on a side; a tap sends that side when it lifts. */
  onPressStart: (key: TerminalArrowKey) => void
  onTap: () => void
  /** Starts repeating an arrow; a new direction replaces the old one. */
  onRepeatStart: (key: TerminalArrowKey) => void
  onRepeatStop: () => void
  onAccessibilityArrow: (key: TerminalArrowKey) => void
  /** Lets the key row stop scrolling while a finger is on the pad. */
  onHoldChange: (held: boolean) => void
  disabled: boolean
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [hot, setHot] = useState<TerminalArrowKey | null>(null)
  const [dragging, setDragging] = useState(false)
  const sizeRef = useRef({ width: 66, height: 32 })
  const dragRef = useRef<Drag | null>(null)
  const onRepeatStopRef = useRef(onRepeatStop)
  useEffect(() => {
    onRepeatStopRef.current = onRepeatStop
  })
  // An unmounting pad never sees the finger lift.
  useEffect(() => () => onRepeatStopRef.current(), [])

  const end = (event: GestureResponderEvent | null): void => {
    const drag = dragRef.current
    dragRef.current = null
    if (drag?.direction) {
      onRepeatStop()
    } else if (event && drag) {
      onTap()
    }
    setHot(null)
    setDragging(false)
    onHoldChange(false)
  }

  const iconColor = (key: TerminalArrowKey) =>
    hot === key ? colors.textPrimary : colors.textSecondary

  return (
    <View
      // The chevrons must not become the touch target, or locationX/Y would be measured from them.
      pointerEvents="box-only"
      style={[styles.arrowPad, dragging && styles.arrowPadDragging, disabled && styles.disabled]}
      onLayout={(event: LayoutChangeEvent) => {
        sizeRef.current = event.nativeEvent.layout
      }}
      onStartShouldSetResponder={() => !disabled}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(event) => {
        const { pageX, pageY, locationX, locationY } = event.nativeEvent
        dragRef.current = { x: pageX, y: pageY, direction: null }
        const { width, height } = sizeRef.current
        const side = sideAt(locationX, locationY, width, height)
        setHot(side)
        onHoldChange(true)
        onPressStart(side)
      }}
      onResponderMove={(event) => {
        const drag = dragRef.current
        if (!drag) {
          return
        }
        const dx = event.nativeEvent.pageX - drag.x
        const dy = event.nativeEvent.pageY - drag.y
        if (Math.hypot(dx, dy) <= DRAG_START_DISTANCE) {
          return
        }
        const direction = directionOf(dx, dy)
        setDragging(true)
        setHot(direction)
        if (direction !== drag.direction) {
          drag.direction = direction
          onRepeatStart(direction)
        }
      }}
      onResponderRelease={end}
      onResponderTerminate={() => end(null)}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={t('session.terminalArrowPad.label', 'Arrow keys')}
      accessibilityHint={t(
        'session.terminalArrowPad.hint',
        'Tap a side for one arrow press, or hold and drag to repeat'
      )}
      accessibilityActions={[
        { name: 'arrowUp', label: t('session.terminalArrowPad.up', 'Up') },
        { name: 'arrowDown', label: t('session.terminalArrowPad.down', 'Down') },
        { name: 'arrowLeft', label: t('session.terminalArrowPad.left', 'Left') },
        { name: 'arrowRight', label: t('session.terminalArrowPad.right', 'Right') },
        { name: 'increment', label: t('session.terminalArrowPad.up', 'Up') },
        { name: 'decrement', label: t('session.terminalArrowPad.down', 'Down') }
      ]}
      onAccessibilityAction={({ nativeEvent }) => {
        const name = nativeEvent.actionName
        if (name === 'increment') {
          onAccessibilityArrow('arrowUp')
        } else if (name === 'decrement') {
          onAccessibilityArrow('arrowDown')
        } else if (
          name === 'arrowUp' ||
          name === 'arrowDown' ||
          name === 'arrowLeft' ||
          name === 'arrowRight'
        ) {
          onAccessibilityArrow(name)
        }
      }}
    >
      <ChevronLeft
        size={12}
        strokeWidth={2.6}
        color={iconColor('arrowLeft')}
        style={styles.arrowLeft}
      />
      <ChevronRight
        size={12}
        strokeWidth={2.6}
        color={iconColor('arrowRight')}
        style={styles.arrowRight}
      />
      <ChevronUp size={11} strokeWidth={2.6} color={iconColor('arrowUp')} style={styles.arrowUp} />
      <ChevronDown
        size={11}
        strokeWidth={2.6}
        color={iconColor('arrowDown')}
        style={styles.arrowDown}
      />
    </View>
  )
}
