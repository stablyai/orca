import { useEffect, useRef, useState } from 'react'
import type { LayoutChangeEvent } from 'react-native'
import {
  REDUCED_MOTION_FADE_MS,
  SHEET_CURVE
} from '../../../../components/motion/sheet-motion-values'
import { useReducedMotionEnabled } from '../../../../platform/accessibility/use-reduced-motion'
import { COMPOSER_CONTROL_SIZE } from '../../../../components/composer-input/composer-input-styles'
import {
  COMPOSER_BOX_EDGE,
  COMPOSER_PILL_GAP,
  mobileNativeChatComposerStylesSheet as stylesSheet
} from './mobile-native-chat-composer-styles'
import { useThemedStyles } from '../../../../theme/themed-styles'

const EASE_MS = 200
const FADE_MS = 150
const EASE = `cubic-bezier(${SHEET_CURVE.join(', ')})`

// rest: the box sizes itself. start: held at its height while the new layout measures. run: easing to it.
type Phase = 'rest' | 'start' | 'run'

/**
 * Eases the composer box between its one-line pill and its full form with the bottom edge fixed, so
 * the transcript gets the space back smoothly; what moved or arrived fades in. CSS transitions, so a
 * toggle mid-way heads to the new height from wherever the box is.
 */
export function useMobileNativeChatComposerCollapse(collapsed: boolean) {
  const styles = useThemedStyles(stylesSheet)
  const reducedMotion = useReducedMotionEnabled() === true
  const edges = 2 * COMPOSER_BOX_EDGE
  // The pill's field stops short of the send slot, which holds the mic, or the mic and Stop.
  const [slotWidth, setSlotWidth] = useState(COMPOSER_CONTROL_SIZE)
  const [phase, setPhase] = useState<Phase>('rest')
  const [height, setHeight] = useState<number | null>(null)
  const [shown, setShown] = useState(collapsed)
  const contentHeight = useRef<number | null>(null)
  if (shown !== collapsed) {
    setShown(collapsed)
    if (contentHeight.current !== null) {
      if (phase === 'rest') {
        setHeight(contentHeight.current + edges)
      }
      setPhase('start')
    }
  }
  useEffect(() => {
    if (phase === 'rest') {
      return
    }
    // Also ends a toggle whose layout never changed height, which reports no new layout.
    const timer = setTimeout(() => {
      setPhase('rest')
      setHeight(null)
    }, EASE_MS + 60)
    return () => clearTimeout(timer)
  }, [phase, height])
  const onContentLayout = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.height
    contentHeight.current = next
    if (phase !== 'rest') {
      setHeight(next + edges)
      setPhase('run')
    }
  }
  const frame =
    phase === 'rest' || height === null
      ? null
      : {
          height,
          overflow: 'hidden' as const,
          ...(reducedMotion
            ? {}
            : {
                transitionProperty: 'height',
                transitionDuration: EASE_MS,
                transitionTimingFunction: EASE
              })
        }
  const fade =
    phase === 'start'
      ? { opacity: 0 }
      : phase === 'run'
        ? {
            opacity: 1,
            transitionProperty: 'opacity',
            transitionDuration: reducedMotion ? REDUCED_MOTION_FADE_MS : FADE_MS,
            transitionTimingFunction: 'ease-out'
          }
        : null
  const field = collapsed ? [styles.pillField, { right: slotWidth + 2 * COMPOSER_PILL_GAP }] : null
  return { frame, fade, field, onContentLayout, onSlotWidth: setSlotWidth }
}
