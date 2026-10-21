import { useCallback, useRef, useState } from 'react'

/**
 * The person's own Stop press, read as "Stopping…" until its request answers, so the control
 * flips on tap. Presentation only: never stored or sent. Desktop parity:
 * `useStructuredAgentSessionStopPress`.
 */
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
        // Answered or failed alike: a failed request keeps its own banner.
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
