import { useCallback, useRef, useState } from 'react'

// Show Stopping immediately while this tap’s request is pending; presentation state stays local.
export function useMobileStructuredStopPress(sessionKey: string): {
  pressed: boolean
  track: <T>(stop: () => Promise<T>) => Promise<T>
} {
  const [press, setPress] = useState<{ sessionKey: string; token: symbol } | null>(null)
  const latest = useRef<symbol | null>(null)
  const track = useCallback(
    async <T>(stop: () => Promise<T>): Promise<T> => {
      const token = Symbol('stop-press')
      latest.current = token
      setPress({ sessionKey, token })
      try {
        return await stop()
      } finally {
        // Failed requests retain their own banner.
        if (latest.current === token) {
          latest.current = null
          setPress(null)
        }
      }
    },
    [sessionKey]
  )
  return { pressed: press?.sessionKey === sessionKey, track }
}
