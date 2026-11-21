// "Connect Linear" / "Connect GitHub" from the phone, as the desktop's connector-connect-state does for a
// paired server: the host runs the trip as its own Orca account, its page opens in Orca's browser on the
// host (in the bot's workspace, so the 127.0.0.1 return reaches the host), and the phone waits on the host.
import { useCallback, useEffect, useRef, useState } from 'react'
import { folderWorkspaceKey } from '../../../../src/shared/workspace/identity/workspace-scope'
import { sessionBrowserTabCreate } from '../../browser/tab-navigation/mobile-session-browser-operations'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { slackCall } from './bot-slack-operations'
import {
  connectCancel,
  connectStart,
  connectWait,
  type PhoneConnectLink
} from './bot-connector-account-operations'

export type PhoneConnectTrip =
  | { status: 'idle' }
  | { status: 'waiting'; since: number }
  | { status: 'linked'; link: PhoneConnectLink }
  | { status: 'failed'; error: string }

/** The page couldn't open in Orca's browser on the host. */
export const CONNECT_NOT_ROUTED = 'not_routed'
/** The host couldn't wait for the return, so the sign-in finishes in Orca there. */
export const CONNECT_ON_HOST = 'loopback_unavailable'
const CANCELLED = 'cancelled'
const EXPIRED = 'expired'
// The cloud's connect session lives this long; a dropped wait is asked again this often.
const TRIP_MS = 10 * 60_000
const RETRY_MS = 2_000
const WAIT_TIMEOUT_MS = 60_000

export function usePhoneConnectTrip(
  client: RpcClient | null,
  source: 'linear' | 'github',
  folderWorkspaceId: string,
  /** Reads the account again once the trip linked, before it shows. */
  onLinked: () => Promise<unknown>
): {
  trip: PhoneConnectTrip
  start: (switchAccount?: boolean) => void
  cancel: () => void
} {
  const [trip, setTrip] = useState<PhoneConnectTrip>({ status: 'idle' })
  // The newest start; a cancel or unmount bumps it, and an older wait stops.
  const latest = useRef(0)
  useEffect(
    () => () => {
      latest.current += 1
    },
    []
  )
  const linked = useRef(onLinked)
  useEffect(() => {
    linked.current = onLinked
  })

  const start = useCallback(
    (switchAccount = false) => {
      if (!client) {
        return
      }
      const request = ++latest.current
      const current = () => request === latest.current
      setTrip({ status: 'waiting', since: Date.now() })
      void (async () => {
        const started = await slackCall(
          () =>
            connectStart.request(client, { source, switchAccount }, { failWhenDisconnected: true }),
          connectStart.interpret
        )
        if (!started.ok) {
          if (current()) {
            setTrip({ status: 'failed', error: started.error })
          }
          return
        }
        // Cancelled or replaced while the host answered: no page for a trip nobody waits on.
        if (!current()) {
          return
        }
        const opened = await sessionBrowserTabCreate
          .request(
            client,
            {
              worktree: `id:${folderWorkspaceKey(folderWorkspaceId)}`,
              url: started.value.authorizeUrl,
              activate: true
            },
            { timeoutMs: 30_000 }
          )
          .then((reply) => sessionBrowserTabCreate.interpret(reply))
          .then(
            () => true,
            () => false
          )
        if (!opened) {
          // Only this trip's own failure ends the host's trip; a newer one there is left alone.
          if (current()) {
            void connectCancel.request(client, { source }).catch(() => {})
            setTrip({ status: 'failed', error: CONNECT_NOT_ROUTED })
          }
          return
        }
        const until = Date.now() + TRIP_MS
        while (current()) {
          const asked = Date.now()
          const waited = await connectWait
            .request(client, { tripId: started.value.tripId }, { timeoutMs: WAIT_TIMEOUT_MS })
            .then((reply) => connectWait.interpret(reply))
            .catch(() => null)
          if (waited?.state === 'done') {
            const result = waited.result
            if (result.ok && result.value) {
              await linked.current()
            }
            if (current()) {
              setTrip(
                result.ok
                  ? // Null: the host had no loopback and the trip ends at "Open Orca", which only it redeems.
                    result.value
                    ? { status: 'linked', link: result.value }
                    : { status: 'failed', error: CONNECT_ON_HOST }
                  : result.error === CANCELLED
                    ? { status: 'idle' }
                    : { status: 'failed', error: result.error }
              )
            }
            return
          }
          if (Date.now() > until) {
            if (current()) {
              setTrip({ status: 'failed', error: EXPIRED })
            }
            return
          }
          // A dropped wait, or a host that answers at once, is asked again after a pause.
          if (!waited || Date.now() - asked < RETRY_MS) {
            await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
          }
        }
      })()
    },
    [client, source, folderWorkspaceId]
  )

  const cancel = useCallback(() => {
    latest.current += 1
    setTrip({ status: 'idle' })
    if (client) {
      void connectCancel.request(client, { source }).catch(() => {})
    }
  }, [client, source])

  return { trip, start, cancel }
}
