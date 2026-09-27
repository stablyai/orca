import { useEffect, useRef } from 'react'
import { BackHandler, Platform } from 'react-native'

/**
 * The shell's half of the device Back key: taken from the navigator while the page is holding it,
 * and given straight back when it is not.
 *
 * Two platforms, two mechanisms, one claim. Android has a hardware key, so the press is intercepted
 * and posted; iOS has none, so what is taken away is the stack's swipe-back gesture — a swipe while
 * a sheet is open would leave the screen with the sheet still on it.
 *
 * Nothing is registered without a live claim, so a page too old to make one, a shell whose page has
 * faulted, and a session between documents all keep today's behaviour: the navigator pops.
 */
export function useShellPageBack(args: {
  claimed: boolean
  /** Posts one press to the page. False when it could not be delivered, which leaves the key to
   *  the navigator for this press rather than swallowing it. */
  sendBack: () => boolean
  /** This screen's own navigator options, from the caller that holds the navigation object. */
  setOptions: (options: { gestureEnabled: boolean }) => void
}): void {
  const { claimed } = args
  // Held rather than depended on: both are rebuilt by the caller's render, and an effect keyed on
  // them would tear the registration down and put it back on every frame of the page beneath it.
  const latest = useRef(args)
  // Written from an effect, not during render, which React replays and discards. Seeded by the
  // `useRef` above, so the two effects below read this render's values on the first mount. No
  // dependency list, because the caller builds a fresh object every render and there is nothing to
  // compare; declared first, so it lands before the two that read it.
  useEffect(() => {
    latest.current = args
  })

  useEffect(() => {
    if (!claimed || Platform.OS !== 'android') {
      return
    }
    // The handler's own answer is the frame's: `false` lets the press fall through to the
    // navigator, which is what a page that cannot be reached has to leave behind.
    const subscription = BackHandler.addEventListener('hardwareBackPress', () =>
      latest.current.sendBack()
    )
    return () => subscription.remove()
  }, [claimed])

  useEffect(() => {
    if (Platform.OS !== 'ios') {
      return
    }
    latest.current.setOptions({ gestureEnabled: !claimed })
  }, [claimed])
}
