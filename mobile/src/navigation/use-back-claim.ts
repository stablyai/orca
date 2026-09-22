import { useEffect, useRef } from 'react'
import { BackHandler } from 'react-native'

/** Returns true when it acted on the press; false hands it on, which is the hardware key's own
 *  rule. Null claims nothing at all. */
export type BackClaim = (() => boolean) | null

/**
 * Native: the device Back key, claimed while the caller has something to do with it.
 *
 * The web sibling is where this earns its name. Inside the shell's page there is no hardware key to
 * intercept — react-native-web answers `BackHandler.addEventListener` with a console warning and an
 * inert subscription — so the page claims the key from the shell over the bridge instead, and the
 * shell hands one press back. One call site, both platforms.
 *
 * The claim is held in a ref, so a caller that rebuilds its handler every render registers once:
 * only taking the key and letting it go move the subscription.
 */
export function useBackClaim(claim: BackClaim): void {
  const latest = useRef(claim)
  // From an effect rather than during render, which React replays and discards. Seeded by the
  // `useRef` above and declared before the registration, so the handler below reads this render's
  // claim from its first press on. No dependency list: the caller rebuilds the handler every
  // render, which is the whole reason it is held rather than depended on.
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
