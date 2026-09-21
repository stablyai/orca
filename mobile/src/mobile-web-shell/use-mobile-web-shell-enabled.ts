import { useEffect, useState } from 'react'
import { loadMobileWebShellEnabled } from '../storage/preferences'

/**
 * The hybrid shell flag, read once per mount.
 *
 * The one product reader of `loadMobileWebShellEnabled`, which is what keeps the flag census
 * meaningful: the routes ask this and nothing asks the storage key twice. `null` is the read still
 * settling, and every caller treats it as off — a route that guessed on would fetch on a flag that
 * is off, which is the one thing the flag exists to prevent.
 *
 * A release build never reaches storage at all; `loadMobileWebShellEnabled` answers false outside
 * `__DEV__` before it looks.
 */
export function useMobileWebShellEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    let stale = false
    void loadMobileWebShellEnabled().then((value) => {
      if (!stale) {
        setEnabled(value)
      }
    })
    return () => {
      stale = true
    }
  }, [])

  return enabled
}
