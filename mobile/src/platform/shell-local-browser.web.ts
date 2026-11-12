import { useMemo } from 'react'
import { useNativeVerbs } from '../mobile-web-shell/bridge/use-native-verbs'
import type { ShellLocalBrowser } from './shell-local-browser-types'

/** A served page asks the app shell to draw the tab in its own web view. */
export function useShellLocalBrowser(): ShellLocalBrowser {
  const verbs = useNativeVerbs()
  return useMemo(
    () => ({
      openFullScreen: verbs.canOpenLocalBrowser ? verbs.openLocalBrowser : null,
      placed: verbs.canPlaceLocalBrowser
        ? {
            show: verbs.placeLocalBrowser,
            move: verbs.moveLocalBrowser,
            remove: verbs.removeLocalBrowser,
            adopt: verbs.adoptLocalBrowserUrl
          }
        : null
    }),
    [verbs]
  )
}
