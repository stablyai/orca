import { PUSH_EASING_CSS, PUSH_SLIDE_MS, PUSH_UNDER_DIM, PUSH_UNDER_SHIFT } from './push-motion'

// Bound suspended-screen waits so a route with no content can still arrive.
const CONTENT_WAIT_CAP_MS = 1000
const UNDER_SHIFT = `translateX(${-PUSH_UNDER_SHIFT * 100}%)`

/** Where an interrupted slide stopped, so the reverse starts there instead of jumping. */
const stoppedAt = new WeakMap<HTMLElement, string>()

/**
 * Slides a pushed screen in over the one under it (or a popped one off it). Compositor animations,
 * so an expensive screen mount cannot stall them. Returns the cancel for an interrupting move.
 */
export function runStackMotion(args: {
  kind: 'push' | 'pop'
  moving: HTMLElement | null
  under: HTMLElement | null
  onSettled: () => void
}): () => void {
  const { kind, moving, under, onSettled } = args
  if (moving === null) {
    return () => {}
  }
  const push = kind === 'push'
  const options: KeyframeAnimationOptions = {
    duration: PUSH_SLIDE_MS,
    easing: PUSH_EASING_CSS,
    fill: 'both'
  }
  const from = (node: HTMLElement, rest: string) => stoppedAt.get(node) ?? rest
  const slide = moving.animate(
    push
      ? [{ transform: from(moving, 'translateX(100%)') }, { transform: 'translateX(0)' }]
      : [{ transform: from(moving, 'translateX(0)') }, { transform: 'translateX(100%)' }],
    options
  )
  slide.onfinish = onSettled
  const dim = under === null ? null : appendDim(under)
  const underSlide =
    under === null
      ? null
      : under.animate(
          push
            ? [{ transform: from(under, 'translateX(0)') }, { transform: UNDER_SHIFT }]
            : [{ transform: from(under, UNDER_SHIFT) }, { transform: 'translateX(0)' }],
          options
        )
  const underDim =
    dim === null
      ? null
      : dim.animate(
          push
            ? [{ opacity: 0 }, { opacity: PUSH_UNDER_DIM }]
            : [{ opacity: PUSH_UNDER_DIM }, { opacity: 0 }],
          options
        )
  const animations = [slide, underSlide, underDim]
  stoppedAt.delete(moving)
  if (under !== null) {
    stoppedAt.delete(under)
  }

  let observer: MutationObserver | null = null
  let cap: ReturnType<typeof setTimeout> | null = null
  // Keep a suspended chunk off-screen, with the screen under it still, until its content commits.
  if (push && moving.childElementCount === 0) {
    for (const animation of animations) {
      animation?.pause()
    }
    const start = () => {
      observer?.disconnect()
      if (cap !== null) {
        clearTimeout(cap)
      }
      for (const animation of animations) {
        animation?.play()
      }
    }
    observer = new MutationObserver(start)
    observer.observe(moving, { childList: true, subtree: true })
    cap = setTimeout(start, CONTENT_WAIT_CAP_MS)
  }

  return () => {
    observer?.disconnect()
    if (cap !== null) {
      clearTimeout(cap)
    }
    // Only an interrupted move hands its position on; a finished one rests where it should.
    if (slide.playState !== 'finished') {
      stoppedAt.set(moving, getComputedStyle(moving).transform)
      if (under !== null) {
        stoppedAt.set(under, getComputedStyle(under).transform)
      }
    }
    for (const animation of animations) {
      animation?.cancel()
    }
    dim?.remove()
  }
}

function appendDim(under: HTMLElement): HTMLElement {
  const dim = document.createElement('div')
  Object.assign(dim.style, {
    position: 'absolute',
    inset: '0',
    background: '#000',
    opacity: '0',
    pointerEvents: 'none'
  })
  under.appendChild(dim)
  return dim
}
