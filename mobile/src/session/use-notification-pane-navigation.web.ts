import { useEffect, useRef, useState } from 'react'
import { usePageBridgeClient } from '../transport/client-context.web'
import type { MobileSessionTab } from './mobile-session-route-types'
import { notificationPaneTab } from './notification-pane-tab'

/**
 * Web sibling: the pane a notification tap asked for, read off the shell rather than off a router.
 *
 * On the page there is no native route to read `paneKey` from and no native param to write back:
 * the page is one document served at `/`, and `setParams` here would rewrite the document's own
 * history entry while the app's route kept the spent tap. The shell delivers the request as a
 * re-sent `init` for the session this page already holds, and tracks nothing about whether it
 * arrived — the reader erases (ruling 34), so this hook is what spends the tap.
 *
 * Two things follow from that, and both are here rather than in the shell. The erase is asked for
 * on every `init` that carries a pane, not only on the one that changed something: a clear that
 * never reached the shell leaves the param in place, and the next `init` carrying it is the repair.
 * The switch happens once per value: a re-asked `ready` is answered with the route the shell still
 * holds, and applying that again would drag the page back off a tab the user has since moved to.
 *
 * The request waits in a ref and a counter wakes the effect, rather than the request living in
 * state: a tap can arrive before the terminals have loaded, and an effect that adjusted state on
 * every delivery would render the stale selection first.
 */
export function useNotificationPaneNavigation({
  sessionTabs,
  terminalsLoaded,
  switchSessionTab
}: {
  sessionTabs: MobileSessionTab[]
  terminalsLoaded: boolean
  switchSessionTab: (tab: MobileSessionTab) => void
}) {
  const client = usePageBridgeClient()
  // Seeded from the route this page was opened on: a tap that opened the session arrives in the
  // first `init` and never as an update, so a hook that only listened would lose it.
  const opened = client.getShellSession()?.route?.params?.paneKey ?? null
  const pending = useRef(opened)
  /** The pane this hook last acted on, so one request is not served twice. Cleared by the erase. */
  const applied = useRef<string | null>(null)
  const [asked, setAsked] = useState(0)

  useEffect(() => {
    // The route this page opened on is erased once, here: it arrived in the first `init`, which
    // is not an update, so nothing below would ever name it back. Read from the client rather
    // than from the render above, which keeps this effect keyed on the client alone.
    const seed = client.getShellSession()?.route?.params?.paneKey ?? null
    if (seed !== null && seed !== '') {
      client.clearRouteParam('paneKey', seed)
    }
    return client.onRouteUpdate((route) => {
      const paneKey = route?.params?.paneKey ?? ''
      if (paneKey === '') {
        // The shell's own erase, and every `ready` answered after it. Not a request, and what
        // releases the next tap for the pane this one named.
        applied.current = null
        return
      }
      // Asked for on arrival rather than on the switch below: the shell holds the request until
      // it hears, so a clear that was lost has to be re-asked by the frame that repeats it.
      client.clearRouteParam('paneKey', paneKey)
      if (paneKey === applied.current) {
        return
      }
      pending.current = paneKey
      setAsked((count) => count + 1)
    })
  }, [client])

  useEffect(() => {
    const paneKey = pending.current
    if (paneKey === null || paneKey === '' || !terminalsLoaded) {
      return
    }
    // Consumed even when the pane has since closed, for the reason the native hook consumes its
    // param: a request left standing is one a later render would serve.
    pending.current = null
    applied.current = paneKey
    const tab = notificationPaneTab(sessionTabs, paneKey)
    if (tab) {
      switchSessionTab(tab)
    }
  }, [asked, sessionTabs, switchSessionTab, terminalsLoaded])
}
