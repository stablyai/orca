// "Connect Linear" / "Connect GitHub" from the phone, as the desktop's connector-connect-state does for a
// paired server: the host runs the trip as its own Orca account, its page opens in Orca's browser on the
// host (in the bot's workspace, so the 127.0.0.1 return reaches the host), and the phone waits on the host.
// The trip lives with the bot's workspace screen, so it keeps waiting while the panel closes to show that page.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type RefObject
} from 'react'
import { sessionBrowserTabCreate } from '../../browser/tab-navigation/mobile-session-browser-operations'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { slackCall } from './bot-slack-operations'
import {
  connectCancel,
  connectStart,
  connectWait,
  type PhoneConnectLink
} from './bot-connector-account-operations'
import type { ConnectorPage } from './connector-pages'

type ConnectSource = 'linear' | 'github'

/** The trip's page in Orca's browser on the host. */
export type ConnectSignInPage = { url: string; browserPageId: string | null }

export type PhoneConnectTrip =
  | { status: 'idle' }
  | { status: 'waiting'; since: number; page: ConnectSignInPage | null }
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
const IDLE: PhoneConnectTrip = { status: 'idle' }

type PhoneConnectTrips = {
  current: { source: ConnectSource; trip: PhoneConnectTrip } | null
  start: (source: ConnectSource, switchAccount: boolean) => void
  cancel: (source: ConnectSource) => void
  /** A setup page left: its ended trip goes, so the next setup starts fresh. */
  release: (source: ConnectSource) => void
  /** The shown setup page: its account is read again once the trip linked, before it shows. */
  shown: RefObject<{ source: ConnectSource; refresh: () => Promise<unknown> } | null>
  /** Shows the trip's page on this phone, then reopens `back` when the trip ends; null where it can't. */
  showSignIn: ((back: ConnectorPage) => void) | null
}

export const PhoneConnectTripContext = createContext<PhoneConnectTrips | null>(null)

/** The bot's workspace screen's one trip; `show` opens its page here, `reopen` returns to its setup. */
export function usePhoneConnectTrips(
  client: RpcClient | null,
  worktreeId: string,
  signIn: {
    show: ((page: ConnectSignInPage) => void) | null
    reopen: (back: ConnectorPage) => void
  }
): PhoneConnectTrips {
  const [current, setCurrent] = useState<PhoneConnectTrips['current']>(null)
  // The newest start; a cancel or unmount bumps it, and an older wait stops.
  const latest = useRef(0)
  useEffect(
    () => () => {
      latest.current += 1
    },
    []
  )
  const shown = useRef<PhoneConnectTrips['shown']['current']>(null)
  const callbacks = useRef(signIn)
  useEffect(() => {
    callbacks.current = signIn
  })
  // The setup the panel closed on to show the page, reopened when the trip ends.
  const away = useRef<ConnectorPage | null>(null)

  const start = useCallback(
    (source: ConnectSource, switchAccount: boolean) => {
      if (!client) {
        return
      }
      const request = ++latest.current
      const current = () => request === latest.current
      away.current = null
      const since = Date.now()
      setCurrent({ source, trip: { status: 'waiting', since, page: null } })
      const end = (trip: PhoneConnectTrip) => {
        const back = away.current
        away.current = null
        if (shown.current?.source === source) {
          setCurrent({ source, trip })
        } else if (back) {
          setCurrent({ source, trip })
          callbacks.current.reopen(back)
        } else {
          // Nobody is looking: the next setup starts fresh, as it did before the trip.
          setCurrent(null)
        }
      }
      void (async () => {
        const started = await slackCall(
          () =>
            connectStart.request(client, { source, switchAccount }, { failWhenDisconnected: true }),
          connectStart.interpret
        )
        if (!started.ok) {
          if (current()) {
            end({ status: 'failed', error: started.error })
          }
          return
        }
        // Cancelled or replaced while the host answered: no page for a trip nobody waits on.
        if (!current()) {
          return
        }
        const url = started.value.authorizeUrl
        const opened = await sessionBrowserTabCreate
          .request(
            client,
            { worktree: `id:${worktreeId}`, url, activate: true },
            { timeoutMs: 30_000 }
          )
          .then((reply) => sessionBrowserTabCreate.interpret(reply))
          .catch(() => null)
        if (!opened) {
          // Only this trip's own failure ends the host's trip; a newer one there is left alone.
          if (current()) {
            void connectCancel.request(client, { source }).catch(() => {})
            end({ status: 'failed', error: CONNECT_NOT_ROUTED })
          }
          return
        }
        if (current()) {
          const page = { url, browserPageId: opened.browserPageId ?? null }
          setCurrent({ source, trip: { status: 'waiting', since, page } })
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
              if (shown.current?.source === source) {
                await shown.current.refresh()
              }
            }
            if (current()) {
              end(
                result.ok
                  ? // Null: the host had no loopback and the trip ends at "Open Orca", which only it redeems.
                    result.value
                    ? { status: 'linked', link: result.value }
                    : { status: 'failed', error: CONNECT_ON_HOST }
                  : result.error === CANCELLED
                    ? IDLE
                    : { status: 'failed', error: result.error }
              )
            }
            return
          }
          if (Date.now() > until) {
            if (current()) {
              end({ status: 'failed', error: EXPIRED })
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
    [client, worktreeId]
  )

  const cancel = useCallback(
    (source: ConnectSource) => {
      latest.current += 1
      away.current = null
      setCurrent(null)
      if (client) {
        void connectCancel.request(client, { source }).catch(() => {})
      }
    },
    [client]
  )

  const release = useCallback((source: ConnectSource) => {
    setCurrent((shown) =>
      shown?.source === source && shown.trip.status !== 'waiting' ? null : shown
    )
  }, [])

  const page = current?.trip.status === 'waiting' ? current.trip.page : null
  const { show } = signIn
  const showSignIn =
    show && page
      ? (back: ConnectorPage) => {
          away.current = back
          show(page)
        }
      : null

  return { current, start, cancel, release, shown, showSignIn }
}

/** One setup page's view of the screen's trip: idle while another source's runs. */
export function usePhoneConnectTrip(
  source: ConnectSource,
  /** Reads the account again once the trip linked, before it shows. */
  onLinked: () => Promise<unknown>
): {
  trip: PhoneConnectTrip
  start: (switchAccount?: boolean) => void
  cancel: () => void
  showSignIn: ((back: ConnectorPage) => void) | null
} {
  const trips = useContext(PhoneConnectTripContext)
  const shown = trips?.shown
  useEffect(() => {
    if (!shown) {
      return
    }
    shown.current = { source, refresh: onLinked }
    return () => {
      shown.current = null
    }
  })
  const release = trips?.release
  useEffect(() => () => release?.(source), [release, source])
  const mine = trips?.current?.source === source ? trips.current.trip : IDLE
  return {
    trip: mine,
    start: (switchAccount = false) => trips?.start(source, switchAccount),
    cancel: () => trips?.cancel(source),
    showSignIn: mine.status === 'waiting' ? (trips?.showSignIn ?? null) : null
  }
}
