import { useCallback, useEffect, useRef, useState } from 'react'
import { loadTerminalTextScale, saveTerminalTextScale } from '../storage/preferences'

// A selection made before the initial storage read resolves must win over that older read.
export function useTerminalTextScaleSetting(): [number, (scale: number) => void] {
  const [textScale, setTextScale] = useState(1)
  const userSelectedRef = useRef(false)
  useEffect(() => {
    let stale = false
    void loadTerminalTextScale().then((scale) => {
      if (!stale && !userSelectedRef.current) {
        setTextScale(scale)
      }
    })
    return () => {
      stale = true
    }
  }, [])
  const selectTextScale = useCallback((scale: number) => {
    userSelectedRef.current = true
    setTextScale(scale)
    void saveTerminalTextScale(scale)
  }, [])
  return [textScale, selectTextScale]
}
