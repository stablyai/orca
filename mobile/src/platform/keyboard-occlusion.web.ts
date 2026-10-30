import { useEffect, useState } from 'react'

export type ShellKeyboardSource = {
  read: () => number
  subscribe: (listener: (height: number) => void) => () => void
}

let shellKeyboard: ShellKeyboardSource | null = null

// Shell WebViews zero IME insets, so visualViewport does not move; use the shell’s reported height.
export function publishShellKeyboardSource(source: ShellKeyboardSource | null): void {
  shellKeyboard = source
}

// RN Web keyboard events are stubs; measure the visual viewport outside the shell, including offsetTop for scrolling.
// Reject zoom geometry because it cannot distinguish keyboard from pinch; 16px inputs avoid focus zoom while preserving accessible pinch zoom. Missing scale means 1 on older WebViews.
function occlusion(viewport: VisualViewport): number {
  if ((viewport.scale ?? 1) !== 1) {
    return 0
  }
  return Math.max(0, window.innerHeight - (viewport.height + viewport.offsetTop))
}

function visualViewport(): VisualViewport | undefined {
  return window.visualViewport ?? undefined
}

// Duration is zero because shell/browser measurements arrive after the keyboard moves.
export function subscribeSoftKeyboard(
  onShow: (height: number, duration: number) => void,
  onHide: (duration: number) => void
): () => void {
  let open = currentSoftKeyboardHeight() > 0
  const read = (height: number): void => {
    if (height > 0) {
      open = true
      onShow(height, 0)
    } else if (open) {
      open = false
      onHide(0)
    }
  }
  if (shellKeyboard !== null) {
    return shellKeyboard.subscribe(read)
  }
  const viewport = visualViewport()
  if (viewport === undefined) {
    return () => {}
  }
  const measure = (): void => read(occlusion(viewport))
  viewport.addEventListener('resize', measure)
  viewport.addEventListener('scroll', measure)

  return () => {
    viewport.removeEventListener('resize', measure)
    viewport.removeEventListener('scroll', measure)
  }
}

// Seed late subscribers: an already-open keyboard sends no new show event.
export function currentSoftKeyboardHeight(): number {
  if (shellKeyboard !== null) {
    return shellKeyboard.read()
  }
  const viewport = visualViewport()
  return viewport === undefined ? 0 : occlusion(viewport)
}

export function useKeyboardOcclusion(): number {
  const [keyboardLift, setKeyboardLift] = useState(0)

  useEffect(() => {
    setKeyboardLift(currentSoftKeyboardHeight())
    return subscribeSoftKeyboard(
      (height) => setKeyboardLift(height),
      () => setKeyboardLift(0)
    )
  }, [])

  return keyboardLift
}

// Unlike native keyboard events, page visibility is inferred from a positive occluded strip.
export type SoftKeyboardState = { readonly height: number; readonly visible: boolean }

export function useSoftKeyboard(): SoftKeyboardState {
  const height = useKeyboardOcclusion()
  return { height, visible: height > 0 }
}
