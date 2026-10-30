import {
  HIDDEN_WINDOW_FRAME_PUMP_INTERVAL_MS,
  hasHiddenWindowFramePumpArgument
} from '../shared/hidden-window-frame-pump'

// Near-black so the single damaged frame is indistinguishable even if the window were visible.
const FLIP_COLOR = 'rgb(1, 1, 1)'

type FramePumpStyle = Pick<
  CSSStyleDeclaration,
  'getPropertyValue' | 'getPropertyPriority' | 'setProperty' | 'removeProperty'
>

export type HiddenWindowFramePumpDeps = {
  rootStyle: () => FramePumpStyle | null
  requestAnimationFrame: (callback: () => void) => unknown
  /** Runs callback every ms; returns the cancel function. */
  every: (callback: () => void, ms: number) => () => void
}

/** Damage one frame per interval by flipping the root background, then restore the inline style exactly. */
export function startHiddenWindowFramePump(deps: HiddenWindowFramePumpDeps): () => void {
  let stopped = false
  let flipping = false
  const cancel = deps.every(() => {
    const style = deps.rootStyle()
    if (stopped || flipping || !style) {
      return
    }
    flipping = true
    deps.requestAnimationFrame(() => {
      const previousValue = style.getPropertyValue('background-color')
      const previousPriority = style.getPropertyPriority('background-color')
      style.setProperty('background-color', FLIP_COLOR, previousPriority)
      deps.requestAnimationFrame(() => {
        if (previousValue) {
          style.setProperty('background-color', previousValue, previousPriority)
        } else {
          style.removeProperty('background-color')
        }
        flipping = false
      })
    })
  }, HIDDEN_WINDOW_FRAME_PUMP_INTERVAL_MS)
  return () => {
    if (!stopped) {
      stopped = true
      cancel()
    }
  }
}

/** Only main's stop ends the pump; Windows can report a never-shown window visible after a desktop change. */
export function installHiddenWindowFramePump(
  argv: readonly string[],
  onStopRequest: (stop: () => void) => void,
  deps: HiddenWindowFramePumpDeps
): void {
  if (hasHiddenWindowFramePumpArgument(argv)) {
    onStopRequest(startHiddenWindowFramePump(deps))
  }
}
