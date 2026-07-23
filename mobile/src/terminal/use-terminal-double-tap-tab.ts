import { useCallback, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { loadTerminalDoubleTapTabEnabled } from '../storage/preferences'
import { resolveTerminalDoubleTapTab, type TerminalTapRecord } from './terminal-double-tap-tab'

export function useTerminalDoubleTapTab(): (handle: string) => boolean {
  const [enabled, setEnabled] = useState(false)
  const lastTapRef = useRef<TerminalTapRecord | null>(null)

  useFocusEffect(
    useCallback(() => {
      let active = true
      void loadTerminalDoubleTapTabEnabled().then((nextEnabled) => {
        if (active) {
          setEnabled(nextEnabled)
        }
      })
      return () => {
        active = false
        lastTapRef.current = null
      }
    }, [])
  )

  return useCallback(
    (handle: string) => {
      const resolution = resolveTerminalDoubleTapTab({
        enabled,
        handle,
        lastTap: lastTapRef.current,
        now: Date.now()
      })
      lastTapRef.current = resolution.nextTap
      return resolution.sendTab
    },
    [enabled]
  )
}
