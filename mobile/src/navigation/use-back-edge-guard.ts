import { useRef, type RefObject } from 'react'
import type { HostInstance } from 'react-native'

export type BackEdgeGuardHandle = {
  ref: RefObject<HostInstance | null>
  onLayout: () => void
}

// Native screens own their gestures; only the web page needs to tell its shell where to keep edge swipes.
export function useBackEdgeGuard(_enabled: boolean): BackEdgeGuardHandle {
  const ref = useRef<HostInstance | null>(null)
  return { ref, onLayout: () => {} }
}
