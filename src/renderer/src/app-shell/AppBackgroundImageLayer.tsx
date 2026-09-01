import type React from 'react'
import { resolveAppBackgroundImageStyle } from '@/lib/app-background-image-style'
import { useAppStore } from '../store'

/** Fixed texture layer over the whole window; inert for pointer, focus, and a11y.
 *  Drawn above surfaces (not behind) because Orca surfaces are opaque — a
 *  low-opacity wash is what makes the image visible without token surgery. */
export function AppBackgroundImageLayer(): React.JSX.Element | null {
  const appBackgroundImage = useAppStore((s) => s.settings?.appBackgroundImage)
  const appBackgroundImageOpacity = useAppStore((s) => s.settings?.appBackgroundImageOpacity)
  const appBackgroundImageFit = useAppStore((s) => s.settings?.appBackgroundImageFit)
  const style = resolveAppBackgroundImageStyle({
    appBackgroundImage,
    appBackgroundImageOpacity,
    appBackgroundImageFit
  })
  if (!style) {
    return null
  }
  return <div aria-hidden className="pointer-events-none fixed inset-0 z-[130]" style={style} />
}
