import { useCallback, useLayoutEffect, useRef } from 'react'
import { useFocusEffect } from 'expo-router'

type Options = {
  readonly onBlur: () => void
  readonly surfaceKey: string
}

/** Fences async send completions after a surface change or retained-route blur. */
export function useMobileSendCompletionGeneration({ onBlur, surfaceKey }: Options): () => number {
  const generationRef = useRef(0)
  const surfaceRef = useRef(surfaceKey)
  useLayoutEffect(() => {
    if (surfaceRef.current !== surfaceKey) {
      surfaceRef.current = surfaceKey
      generationRef.current += 1
    }
  }, [surfaceKey])
  useFocusEffect(
    useCallback(() => {
      return () => {
        generationRef.current += 1
        onBlur()
      }
    }, [onBlur])
  )
  return useCallback(() => generationRef.current, [])
}
