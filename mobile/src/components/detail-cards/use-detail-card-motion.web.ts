import { useEffectEvent, useLayoutEffect, useRef } from 'react'
import type { DetailCardMotionOptions } from './use-detail-card-motion'
import { commitDetailCardExit } from './detail-card-host'

type Presentation = { opacity: string; transform: string }

export function useDetailCardMotion({
  contentRef,
  motion,
  target,
  slide,
  offset,
  duration,
  onSettled
}: DetailCardMotionOptions) {
  const currentAnimation = useRef<Animation | null>(null)
  const interrupted = useRef<Presentation | null>(null)
  const readOffset = useEffectEvent(() => (slide ? offset : 0))
  useLayoutEffect(() => {
    const element = contentRef.current
    if (!(element instanceof HTMLElement)) {
      return
    }
    const translate = readOffset()
    const from = interrupted.current ?? {
      opacity: '0',
      transform: `translateY(${translate}px)`
    }
    const to = { opacity: String(target), transform: `translateY(${target ? 0 : translate}px)` }
    if (!translate) {
      from.transform = 'translateY(0px)'
    }
    if (typeof element.animate !== 'function' || (target === 0 && Number(from.opacity) === 0)) {
      if (target === 0) {
        onSettled(motion)
      }
      return
    }
    let disposed = false
    const animation = element.animate([from, to], {
      duration,
      easing: 'cubic-bezier(0.3333333333, 1, 0.6666666667, 1)',
      // Keep the presentation readable across React committing the next endpoint before cleanup.
      fill: 'forwards'
    })
    currentAnimation.current = animation
    animation.onfinish = () => {
      if (!disposed && target === 0) {
        commitDetailCardExit(() => onSettled(motion))
      }
    }
    return () => {
      disposed = true
      const current = getComputedStyle(element)
      interrupted.current = { opacity: current.opacity, transform: current.transform }
      animation.cancel()
      currentAnimation.current = null
    }
  }, [contentRef, motion, target, duration, onSettled])
  useLayoutEffect(() => {
    const effect = currentAnimation.current?.effect
    if (slide || !effect) {
      return
    }
    if (effect instanceof KeyframeEffect) {
      effect.setKeyframes(
        effect.getKeyframes().map((frame) => {
          const fadeOnly = { ...frame }
          delete fadeOnly.transform
          return fadeOnly
        })
      )
    }
  }, [slide])
  return {
    opacity: target,
    transform: slide ? [{ translateY: target ? 0 : offset }] : []
  }
}
