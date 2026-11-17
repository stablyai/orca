import { useEffect, useState } from 'react'
import { Text, type StyleProp, type TextStyle } from 'react-native'
import { formatElapsed } from './cloud-workspace-display'

/** A ticking "12s" leaf: only this re-renders each second, and screen readers skip it. */
export function CloudElapsed({ since, style }: { since: number; style?: StyleProp<TextStyle> }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  return (
    <Text style={style} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {formatElapsed(now - since)}
    </Text>
  )
}
