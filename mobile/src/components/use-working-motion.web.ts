import { useCallback, useEffect, useState } from 'react'
import type { WorkingMotion } from './use-working-motion'

// Web Animations on the element run on the compositor, so a busy page cannot stall them the way
// a JS-driven Animated loop is stalled; every ring shares one phase, like desktop's spinner.
function useElementLoop(
  active: boolean,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
  sharePhase = true
): (node: unknown) => void {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const ref = useCallback(
    (node: unknown) => setElement(node instanceof HTMLElement ? node : null),
    []
  )
  useEffect(() => {
    if (!active || element === null || typeof element.animate !== 'function') {
      return undefined
    }
    const animation = element.animate(keyframes, { ...options, iterations: Infinity })
    if (sharePhase) {
      animation.startTime = 0
    }
    return () => animation.cancel()
  }, [active, element, keyframes, options, sharePhase])
  return ref
}

const SPIN: Keyframe[] = [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }]
const SPIN_TIMING: KeyframeAnimationOptions = { duration: 1000, easing: 'linear' }
// Desktop's animate-pulse: the curve eases each half of the 2s breath.
const PULSE_CURVE = 'cubic-bezier(0.4, 0, 0.6, 1)'
const PULSE: Keyframe[] = [
  { opacity: 1, easing: PULSE_CURVE },
  { opacity: 0.5, easing: PULSE_CURVE },
  { opacity: 1 }
]
const PULSE_TIMING: KeyframeAnimationOptions = { duration: 2000 }
const SWEEP: Keyframe[] = [{ transform: 'translateX(-100%)' }, { transform: 'translateX(360%)' }]
const SWEEP_TIMING: KeyframeAnimationOptions = {
  duration: 1400,
  easing: 'cubic-bezier(0.45, 0, 0.55, 1)'
}

export function useWorkingRingRotation(active: boolean): WorkingMotion<never> {
  return { ref: useElementLoop(active, SPIN, SPIN_TIMING), style: undefined }
}

export function useWorkingPulse(active: boolean): WorkingMotion<never> {
  return { ref: useElementLoop(active, PULSE, PULSE_TIMING), style: undefined }
}

// Percent keyframes follow the segment's own width, so the page needs no layout pass.
// Each reveal starts at the left edge: a shared phase could show a short reveal only as it exits right.
export function useWorkingSweep(active: boolean): WorkingMotion<never> & { onLayout: undefined } {
  return {
    ref: useElementLoop(active, SWEEP, SWEEP_TIMING, false),
    style: undefined,
    onLayout: undefined
  }
}
