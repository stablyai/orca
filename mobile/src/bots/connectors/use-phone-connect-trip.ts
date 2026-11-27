// "Connect Linear" / "Connect GitHub" and Google's sign-in from the phone, as the desktop does for a paired
// server: the host runs the trip (Linear and GitHub as its own Orca account), its page opens in Orca's browser
// on the host (in the bot's workspace, so the 127.0.0.1 return reaches the host), and the phone waits there.
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
import { connectCancel } from './bot-connector-account-operations'
import {
  beginConnect,
  beginGoogle,
  CANCELLED,
  EXPIRED,
  IDLE,
  pause,
  RETRY_MS,
  TRIP_MS,
  type ConnectSignInPage,
  type HostTripCancel,
  type PhoneConnectTrip
} from './connect-host-trip'
import type { ConnectorPage, GoogleSignInAsk } from './connector-pages'

type ConnectSource = 'linear' | 'github' | 'google'

/** What a sign-in asks: Linear's or GitHub's account picker, or Google's account and services. */
type ConnectAsk =
  | { source: 'linear' | 'github'; switchAccount: boolean }
  | ({ source: 'google' } & GoogleSignInAsk)

/** The page couldn't open in Orca's browser on the host. */
export const CONNECT_NOT_ROUTED = 'not_routed'

type PhoneConnectTrips = {
  current: { source: ConnectSource; trip: PhoneConnectTrip } | null
  start: (ask: ConnectAsk) => void
  cancel: (source: ConnectSource) => void
  /** A setup page left: its ended trip goes, so the next setup starts fresh. */
  release: (source: ConnectSource) => void
  /** The shown setup page: its account is read again once the trip linked, before it shows. */
  shown: RefObject<{ source: ConnectSource; refresh: () => Promise<unknown> } | null>
  /** Shows the trip's page on this phone, then reopens `back` when the trip ends; null where it can't. */
  showSignIn: ((back: ConnectorPage) => void) | null
  /** Cancels the sign-in shown here and reopens its setup. */
  cancelSignIn: () => void
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
  // The current trip's side on the host, once it answered.
  const running = useRef<HostTripCancel | null>(null)
  // The last Google start: the next waits for it, so it never resumes a flow that one is ending.
  const googleStart = useRef<Promise<unknown>>(Promise.resolve())
  useEffect(
    () => () => {
      latest.current += 1
      // A Google sign-in is this phone's own, so it ends with the screen.
      if (running.current?.own) {
        running.current.cancel()
      }
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
    (ask: ConnectAsk) => {
      if (!client) {
        return
      }
      const { source } = ask
      const request = ++latest.current
      const current = () => request === latest.current
      away.current = null
      // Only one Google sign-in runs on a host, so a newer start ends this phone's last one.
      if (running.current?.own) {
        running.current.cancel()
      }
      running.current = null
      const since = Date.now()
      setCurrent({ source, trip: { status: 'waiting', since, page: null } })
      const end = (trip: PhoneConnectTrip) => {
        const back = away.current
        away.current = null
        running.current = null
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
        let started
        if (ask.source === 'google') {
          const begun = googleStart.current.then(() =>
            beginGoogle(client, ask, current, (host) => {
              running.current = host
            })
          )
          googleStart.current = begun
          started = await begun
        } else {
          started = await beginConnect(client, ask.source, ask.switchAccount)
        }
        if (!started.ok) {
          if (current()) {
            end(started.error === CANCELLED ? IDLE : { status: 'failed', error: started.error })
          }
          return
        }
        // Cancelled or replaced while the host answered: no page for a trip nobody waits on.
        if (!current()) {
          return
        }
        const host = started.trip
        running.current = host
        const { url } = host
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
            host.cancel()
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
          const ended = await host.wait()
          if (ended) {
            if (ended.status === 'linked' && shown.current?.source === source) {
              await shown.current.refresh()
            }
            if (current()) {
              end(ended)
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
          if (Date.now() - asked < RETRY_MS) {
            await pause()
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
      const host = running.current
      running.current = null
      setCurrent(null)
      if (host) {
        host.cancel()
      } else if (client && source !== 'google') {
        // Before the host answered: Google's start ends its own flow once it answers.
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

  const cancelSignIn = useCallback(() => {
    const back = away.current
    // A trip that ended while the sheet closed already reopened its setup.
    if (!back) {
      return
    }
    if (current) {
      cancel(current.source)
    }
    // A page that opened on the sign-in would start it again, so Cancel returns where it came from.
    callbacks.current.reopen(
      back.kind === 'google-sign-in' ||
        ((back.kind === 'linear-setup' || back.kind === 'github-setup') && back.signIn)
        ? back.from
        : back
    )
  }, [cancel, current])

  const page = current?.trip.status === 'waiting' ? current.trip.page : null
  const { show } = signIn
  const showSignIn =
    show && page
      ? (back: ConnectorPage) => {
          away.current = back
          show(page)
        }
      : null

  return { current, start, cancel, release, shown, showSignIn, cancelSignIn }
}

/** One setup page's view of the screen's trip: idle while another source's runs. */
export function usePhoneConnectTrip(
  source: ConnectSource,
  /** Reads the account again once the trip linked, before it shows. */
  onLinked: () => Promise<unknown>
): {
  trip: PhoneConnectTrip
  /** Linear's and GitHub's take whether to switch accounts; Google's, the account and services. */
  start: (ask?: boolean | GoogleSignInAsk) => void
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
    start: (ask) =>
      trips?.start(
        source === 'google'
          ? { source, ...(typeof ask === 'object' ? ask : {}) }
          : { source, switchAccount: ask === true }
      ),
    cancel: () => trips?.cancel(source),
    showSignIn: mine.status === 'waiting' ? (trips?.showSignIn ?? null) : null
  }
}

/** Starts the sign-in with the account picker once, as the page opens for one; a page reopened after
 *  showing the sign-in here finds its trip running or ended, and leaves it be. */
export function useSignInOnOpen(
  signIn: boolean,
  trip: PhoneConnectTrip,
  start: (switchAccount: boolean) => void
): void {
  const started = useRef(false)
  const idle = trip.status === 'idle'
  useEffect(() => {
    if (signIn && !started.current) {
      started.current = true
      if (idle) {
        start(true)
      }
    }
  }, [signIn, idle, start])
}
