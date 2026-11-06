// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import { AnchoredDetailCardLayer } from './AnchoredDetailCard'
import type { AnchoredDetailCardState } from './use-anchored-detail-card'

vi.mock('react-native', () => import('react-native-web'))
vi.mock('./use-detail-card-motion', () => import('./use-detail-card-motion.web'))
vi.mock('../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'light' }))
const preference = vi.hoisted((): { enabled: boolean | null } => ({ enabled: false }))
vi.mock('../platform/use-reduced-motion', () => ({
  useReducedMotionEnabled: () => preference.enabled
}))

type Fade = {
  from: { opacity: string; transform: string }
  to: { opacity: string; transform: string }
  current: { opacity: string; transform: string }
  finish: () => void
  cancelled: boolean
  slides: boolean
}
let fades: Fade[]
let root: Root
let container: HTMLDivElement
let activeFade: Fade | undefined
const settled = vi.fn()
const contentRef: AnchoredDetailCardState['contentRef'] = { current: null }
const animateDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate')
const baseComputedStyle = globalThis.getComputedStyle
const card = mountFixture<AnchoredDetailCardState>({
  contentRef,
  layerRef: { current: null },
  boundaryRefs: { current: [] },
  bounds: { left: 0, top: 0, right: 400, bottom: 800 },
  layerHeight: 800,
  onLayout: () => {},
  onSettled: settled
})
function render(target: 0 | 1, motion: number) {
  act(() =>
    root.render(
      createElement(AnchoredDetailCardLayer, {
        card: {
          ...card,
          visual: {
            anchor: { side: 'below', left: 20, top: 100, origin: { x: 0, y: 0 } },
            target,
            motion
          },
          active: target === 1
        },
        obscured: false,
        title: 'Workspace'
      })
    )
  )
}
function presentation() {
  const element = container.querySelector('[role="dialog"]')
  if (!(element instanceof HTMLElement)) {
    throw new Error('Missing card')
  }
  return getComputedStyle(element)
}
beforeEach(() => {
  fades = []
  activeFade = undefined
  settled.mockClear()
  preference.enabled = false
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((element) => {
    const style = baseComputedStyle(element)
    if (!activeFade || element.getAttribute('role') !== 'dialog') {
      return style
    }
    const current = activeFade.current
    const sampled = document.createElement('div').style
    sampled.cssText = style.cssText
    sampled.opacity = current.opacity
    sampled.transform = activeFade.slides ? current.transform : style.transform
    return sampled
  })
  class BrowserKeyframeEffect {
    frames: Keyframe[]
    constructor(
      frames: Keyframe[],
      private fade: Fade
    ) {
      this.frames = frames
    }
    getKeyframes() {
      return this.frames
    }
    setKeyframes(frames: Keyframe[]) {
      this.frames = frames
      this.fade.slides = frames.some((frame) => frame.transform !== undefined)
    }
  }
  vi.stubGlobal('KeyframeEffect', BrowserKeyframeEffect)
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value: (frames: Keyframe[], options: KeyframeAnimationOptions) => {
      const from = { opacity: String(frames[0].opacity), transform: String(frames[0].transform) }
      const to = { opacity: String(frames[1].opacity), transform: String(frames[1].transform) }
      const animation = mountFixture<Animation>({
        onfinish: null,
        cancel: () => {
          fade.cancelled = true
          if (activeFade === fade) {
            activeFade = undefined
          }
        }
      })
      const fade: Fade = {
        from,
        to,
        current: from,
        cancelled: false,
        slides: true,
        finish: () => {
          fade.current = to
          if (options.fill !== 'forwards' && activeFade === fade) {
            activeFade = undefined
          }
          animation.onfinish?.(mountFixture<AnimationPlaybackEvent>({ type: 'finish' }))
        }
      }
      Object.defineProperty(animation, 'effect', { value: new BrowserKeyframeEffect(frames, fade) })
      fades.push(fade)
      activeFade = fade
      return animation
    }
  })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (animateDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'animate', animateDescriptor)
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'animate')
  }
})

it('keeps the completed endpoint and fades out from the visible card after completion', () => {
  render(1, 1)
  const opening = fades[0]
  expect(presentation().opacity).toBe('0')
  opening.finish()
  expect(presentation().opacity).toBe('1')
  expect(presentation().transform).toBe('translateY(0px)')
  render(0, 2)
  expect(fades[1].from.opacity).toBe('1')
  expect(presentation().opacity).toBe('1')
  expect(settled).not.toHaveBeenCalled()
  act(() => fades[1].finish())
  expect(presentation().opacity).toBe('0')
  expect(settled).toHaveBeenCalledExactlyOnceWith(2)
  // Cancellation exposes React's endpoint, even before a finish handler could run.
  activeFade = undefined
  expect(presentation().opacity).toBe('0')
})

it('reverses an interrupted fade and ignores the cancelled exits stale finish', () => {
  render(1, 1)
  fades[0].current = { opacity: '0.4', transform: 'translateY(-3.6px)' }
  render(0, 2)
  expect(presentation().opacity).toBe('0.4')
  const closing = fades[1]
  closing.current = { opacity: '0.2', transform: 'translateY(-4.8px)' }
  render(1, 3)
  expect(presentation().opacity).toBe('0.2')
  expect(presentation().transform).toBe('translateY(-4.8px)')
  closing.finish()
  expect(settled).not.toHaveBeenCalled()
  fades[2].finish()
  expect(presentation().opacity).toBe('1')
})

it('keeps unknown and reduced motion fade-only and an open preference update stationary', () => {
  preference.enabled = null
  render(1, 1)
  expect(['', 'none', 'translateY(0px)']).toContain(presentation().transform)
  fades[0].finish()
  preference.enabled = false
  render(1, 1)
  expect(['', 'none', 'translateY(0px)']).toContain(presentation().transform)
  preference.enabled = true
  render(0, 2)
  expect(['', 'none', 'translateY(0px)']).toContain(presentation().transform)
  fades[1].finish()
  expect(['', 'none', 'translateY(0px)']).toContain(presentation().transform)
})

it('shows the endpoint and releases exits when browser animation is unavailable', () => {
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: undefined })
  render(1, 1)
  expect(presentation().opacity).toBe('1')
  render(0, 2)
  expect(presentation().opacity).toBe('0')
  expect(settled).toHaveBeenCalledExactlyOnceWith(2)
})

it('removes a live slide without restarting opacity when reduced motion is enabled', () => {
  render(1, 1)
  fades[0].finish()
  render(0, 2)
  const closing = fades[1]
  closing.current = { opacity: '0.5', transform: 'translateY(-3px)' }
  preference.enabled = true
  render(0, 2)
  expect(presentation().transform).toBe('')
  expect(presentation().opacity).toBe('0.5')
  act(() => closing.finish())
  expect(settled).toHaveBeenCalledExactlyOnceWith(2)
})
