import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { loadTerminalDoubleTapTabEnabled } from '../storage/preferences'
import { resolveTerminalDoubleTapTab, type TerminalTapRecord } from './terminal-double-tap-tab'

export type TerminalDoubleTapTabHandlers = {
  readonly cancelPendingTap: () => void
  readonly shouldSendTabForTap: (handle: string) => boolean
}

export function useTerminalDoubleTapTab(
  activeHandle: string | null,
  lifecycleKey: string
): TerminalDoubleTapTabHandlers {
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
        setEnabled(false)
        lastTapRef.current = null
      }
    }, [])
  )

  useEffect(() => {
    lastTapRef.current = null
  }, [activeHandle, lifecycleKey])

  const cancelPendingTap = useCallback(() => {
    lastTapRef.current = null
  }, [])

  const shouldSendTabForTap = useCallback(
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

  return { cancelPendingTap, shouldSendTabForTap }
}
