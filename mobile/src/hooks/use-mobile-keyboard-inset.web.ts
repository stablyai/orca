import { useEffect, useState } from 'react'
import type { MobileKeyboardInset } from './use-mobile-keyboard-inset'

export function measureMobileWebKeyboardInset(
  innerHeight: number,
  viewport: Pick<VisualViewport, 'height' | 'offsetTop'> | null
): number {
  return viewport ? Math.max(0, Math.round(innerHeight - viewport.height - viewport.offsetTop)) : 0
}

export function useMobileKeyboardInset(): MobileKeyboardInset {
  const [inset, setInset] = useState<MobileKeyboardInset>({ height: 0, duration: 0 })

  useEffect(() => {
    const viewport = window.visualViewport
    const update = () => {
      const height = measureMobileWebKeyboardInset(window.innerHeight, viewport)
      setInset((current) =>
        current.height === height ? current : { height, duration: current.duration === 0 ? 0 : 250 }
      )
    }
    update()
    if (!viewport) {
      return
    }
    const animatedUpdate = () => {
      const height = measureMobileWebKeyboardInset(window.innerHeight, viewport)
      setInset((current) => (current.height === height ? current : { height, duration: 250 }))
    }
    viewport.addEventListener('resize', animatedUpdate)
    viewport.addEventListener('scroll', animatedUpdate)
    return () => {
      viewport.removeEventListener('resize', animatedUpdate)
      viewport.removeEventListener('scroll', animatedUpdate)
    }
  }, [])

  return inset
}
