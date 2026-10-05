import { useEffect, useState } from 'react'
import { loadMobileWebShellEnabled, mobileWebShellFlagCanBeOn } from '../storage/preferences'

/**
 * The hybrid shell flag, read once per mount.
 *
 * The one product reader of `loadMobileWebShellEnabled`, which is what keeps the flag census
 * meaningful: the routes ask this and nothing asks the storage key twice. `null` is the read still
 * settling, which `shell-switch-decision.ts` turns into a neutral frame rather than a guess.
 *
 * That frame is worth a native mount only where the flag could resolve on, so a build that cannot
 * have it on starts at `false` rather than `null`: `mobileWebShellFlagCanBeOn` is the same fact
 * `loadMobileWebShellEnabled` would answer with, one render earlier, and it makes `null`
 * unreachable on a native store build — one built without `EXPO_PUBLIC_MOBILE_SHELL=ota`, which is
 * every default build. A build made with it reaches the neutral frame like a development build
 * does. The effect still runs either way, because the initialiser is a starting point and the read
 * is what decides.
 */
export function useMobileWebShellEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(() =>
    mobileWebShellFlagCanBeOn() ? null : false
  )

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
