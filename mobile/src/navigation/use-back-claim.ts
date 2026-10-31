import { useEffect, useRef } from 'react'
import { BackHandler } from 'react-native'

// True consumes, false falls through; null claims nothing.
export type BackClaim = (() => boolean) | null

// Hold native Back registration across fresh handler closures; the web sibling claims shell Back because RN Web’s BackHandler is inert.
export function useBackClaim(claim: BackClaim): void {
  const latest = useRef(claim)
  // Update on commit before registering so replayed/discarded renders cannot replace the active handler.
  useEffect(() => {
    latest.current = claim
  })
  const claimed = claim !== null

  useEffect(() => {
    if (!claimed) {
      return
    }
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => latest.current?.() ?? false
    )
    return () => subscription.remove()
  }, [claimed])
}
