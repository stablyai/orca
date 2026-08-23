import { useEffect, useState } from 'react'
import { Dimensions, PixelRatio } from 'react-native'

export function usePixelRatio(): number {
  const [pixelRatio, setPixelRatio] = useState(() => PixelRatio.get())

  useEffect(() => {
    // Android changes arrive through MainActivity's display-metrics hook.
    const subscription = Dimensions.addEventListener('change', () =>
      setPixelRatio(PixelRatio.get())
    )
    return () => subscription.remove()
  }, [])

  return pixelRatio
}
