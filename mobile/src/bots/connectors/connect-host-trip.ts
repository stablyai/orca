// One trip's side on the host, for the phone's connect trips (use-phone-connect-trip): Linear's and GitHub's
// through Orca Cloud (bots.connect.*), and Google's own sign-in (google.signIn.*), which the host keeps.
import { isHostNotConnectedError } from '../../query/host-query-errors'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { HOST_OFFLINE, slackCall } from './bot-slack-operations'
import {
  connectCancel,
  connectStart,
  connectWait,
  googleSignInCancel,
  googleSignInStart,
  googleSignInWait,
  type PhoneConnectLink
} from './bot-connector-account-operations'
import type { GoogleSignInAsk } from './connector-pages'

/** The trip's page in Orca's browser on the host. */
export type ConnectSignInPage = { url: string; browserPageId: string | null }

export type PhoneConnectTrip =
  | { status: 'idle' }
  | { status: 'waiting'; since: number; page: ConnectSignInPage | null }
  /** Google's link is null: its page reads the accounts again. */
  | { status: 'linked'; link: PhoneConnectLink }
  | { status: 'failed'; error: string }

/** The host couldn't wait for the return, so the sign-in finishes in Orca there. */
export const CONNECT_ON_HOST = 'loopback_unavailable'
export const CANCELLED = 'cancelled'
export const EXPIRED = 'expired'
// The cloud's connect session lives this long; a dropped wait is asked again this often.
export const TRIP_MS = 10 * 60_000
export const RETRY_MS = 2_000
const WAIT_TIMEOUT_MS = 60_000
export const IDLE: PhoneConnectTrip = { status: 'idle' }
/** Google's sign-in ended without saying why. */
export const GOOGLE_SIGN_IN_FAILED = 'google_failed'

export const pause = () => new Promise((resolve) => setTimeout(resolve, RETRY_MS))

/** Cancels a trip's side on the host. `own`: a flow only this phone started (Google's), which ends with
 *  the screen; Linear's and GitHub's cloud trip is cancelled per source, so leaving leaves it be. */
export type HostTripCancel = { cancel: () => void; own: boolean }

/** A trip's side on the host: its page and one wait (null while it still waits). */
export type HostTrip = HostTripCancel & {
  url: string
  wait: () => Promise<PhoneConnectTrip | null>
}
export type HostTripStart = { ok: true; trip: HostTrip } | { ok: false; error: string }

export async function beginConnect(
  client: RpcClient,
  source: 'linear' | 'github',
  switchAccount: boolean
): Promise<HostTripStart> {
  const started = await slackCall(
    () => connectStart.request(client, { source, switchAccount }, { failWhenDisconnected: true }),
    connectStart.interpret
  )
  if (!started.ok) {
    return started
  }
  const { tripId, authorizeUrl } = started.value
  return {
    ok: true,
    trip: {
      url: authorizeUrl,
      own: false,
      cancel: () => void connectCancel.request(client, { source }).catch(() => {}),
      wait: async () => {
        const waited = await connectWait
          .request(client, { tripId }, { timeoutMs: WAIT_TIMEOUT_MS })
          .then((reply) => connectWait.interpret(reply))
          .catch(() => null)
        if (waited?.state !== 'done') {
          return null
        }
        const { result } = waited
        return result.ok
          ? // Null: the host had no loopback and the trip ends at "Open Orca", which only it redeems.
            result.value
            ? { status: 'linked', link: result.value }
            : { status: 'failed', error: CONNECT_ON_HOST }
          : result.error === CANCELLED
            ? IDLE
            : { status: 'failed', error: result.error }
      }
    }
  }
}

type GoogleStatus = ReturnType<typeof googleSignInWait.interpret>

function googleEnd(status: GoogleStatus): PhoneConnectTrip | null {
  switch (status.phase) {
    case 'signedIn':
      return { status: 'linked', link: null }
    case 'cancelled':
      return IDLE
    case 'failed':
      return { status: 'failed', error: status.error ?? GOOGLE_SIGN_IN_FAILED }
    default:
      return null
  }
}

/** Google's sign-in as the desktop runs it for a paired server: the host keeps the flow and its loopback,
 *  and its page opens in Orca's browser there. `started` gets the flow's cancel as soon as there is one, and
 *  only that cancels it: a later start for the same account resumes the same flow, so a stale wait never does. */
export async function beginGoogle(
  client: RpcClient,
  { account, services, currentApp }: GoogleSignInAsk,
  current: () => boolean,
  started: (cancel: HostTripCancel) => void
): Promise<HostTripStart> {
  let status: GoogleStatus
  try {
    status = googleSignInStart.interpret(
      await googleSignInStart.request(
        client,
        { account, services, currentApp },
        { failWhenDisconnected: true }
      )
    )
  } catch (error) {
    return {
      ok: false,
      error: isHostNotConnectedError(error)
        ? HOST_OFFLINE
        : error instanceof Error && error.message
          ? error.message
          : GOOGLE_SIGN_IN_FAILED
    }
  }
  const { flowId } = status
  const cancel = () => void googleSignInCancel.request(client, { flowId }).catch(() => {})
  // Cancelled or left while the host answered: nobody holds this flow yet, so it ends here, before the
  // next start (which waits on this one) could resume it.
  if (!current()) {
    await googleSignInCancel.request(client, { flowId }).catch(() => {})
    return { ok: false, error: CANCELLED }
  }
  started({ cancel, own: true })
  /** The flow's next state; null when the ask dropped, a failed trip when the host refuses it (it restarted). */
  const next = async (): Promise<GoogleStatus | PhoneConnectTrip | null> => {
    const reply = await googleSignInWait
      .request(client, { flowId, afterRevision: status.revision }, { timeoutMs: WAIT_TIMEOUT_MS })
      .catch(() => null)
    if (!reply) {
      return null
    }
    try {
      status = googleSignInWait.interpret(reply)
      return status
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error && error.message ? error.message : GOOGLE_SIGN_IN_FAILED
      }
    }
  }
  const until = Date.now() + TRIP_MS
  // Google's page comes once the host has picked the app to sign in through.
  for (;;) {
    const url = status.phase === 'waiting' ? status.prompt?.authorizeUrl : undefined
    const ended = googleEnd(status)
    if (!url && ended) {
      return { ok: false, error: ended.status === 'failed' ? ended.error : CANCELLED }
    }
    if (!current()) {
      return { ok: false, error: CANCELLED }
    }
    if (Date.now() > until) {
      cancel()
      return { ok: false, error: EXPIRED }
    }
    if (url) {
      return {
        ok: true,
        trip: {
          url,
          cancel,
          own: true,
          wait: async () => {
            const read = await next()
            return read && 'flowId' in read ? googleEnd(read) : read
          }
        }
      }
    }
    const asked = Date.now()
    const read = await next()
    if (read && !('flowId' in read)) {
      return { ok: false, error: read.status === 'failed' ? read.error : CANCELLED }
    }
    if (read === null || Date.now() - asked < RETRY_MS) {
      await pause()
    }
  }
}
