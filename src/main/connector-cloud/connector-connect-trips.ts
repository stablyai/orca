// A Linear or GitHub connect run on this host for whichever client asks: the client opens the page
// (for a server, in that server's own browser session, whose loopback is the server's), and the host
// waits for the return and redeems it as its own Orca account.
import { randomUUID } from 'node:crypto'
import {
  BOT_SLACK_DESKTOP_ERRORS,
  type BotSlackResult
} from '../../shared/connector-bot-slack-contract'
import type { ConnectorConnectSource } from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorConnectRedeem } from '../../../cloud/packages/connector-contract/src/connect-messages'
import { type ConnectAddAccess, connectConnector, type KeepConnectLogin } from './connector-connect'

/** A trip's end: the linked account, or null when it ends at "Open Orca" and its deep link redeems. */
export type ConnectorTripResult = BotSlackResult<ConnectorConnectRedeem | null>

export type ConnectorTripWait =
  | { state: 'waiting' }
  | { state: 'done'; result: ConnectorTripResult }

type Trip = {
  source: ConnectorConnectSource
  result: ConnectorTripResult | null
  ended: Promise<void>
}

// A client's wait returns before a paired connection's call deadline, and is asked again.
const WAIT_SLICE_MS = 45_000

// The newest trip per source, as connectConnector keeps one; older ids answer "expired".
const trips = new Map<string, Trip>()

/** Starts a trip and answers its page once the host listens, or the trip's failure; `addAccess`
 *  says the trip added access as asked, which an older host never says. */
export async function startConnectorTrip(
  source: ConnectorConnectSource,
  client: Parameters<typeof connectConnector>[1],
  options: { switchAccount: boolean; keepLogin?: KeepConnectLogin; addAccess?: ConnectAddAccess }
): Promise<BotSlackResult<{ tripId: string; authorizeUrl: string; addAccess?: true }>> {
  let opened: (url: string) => void = () => {}
  const page = new Promise<string>((resolve) => {
    opened = resolve
  })
  const outcome = connectConnector(source, client, {
    ...options,
    openExternal: async (url) => opened(url)
  })
  const tripId = randomUUID()
  const trip: Trip = { source, result: null, ended: Promise.resolve() }
  trip.ended = outcome.then((result) => {
    trip.result = result
  })
  for (const [id, other] of trips) {
    if (other.source === source) {
      trips.delete(id)
    }
  }
  trips.set(tripId, trip)
  const first = await Promise.race([
    page.then((authorizeUrl) => ({ authorizeUrl })),
    outcome.then((result) => ({ result }))
  ])
  if ('authorizeUrl' in first) {
    return {
      ok: true,
      value: {
        tripId,
        authorizeUrl: first.authorizeUrl,
        ...(options.addAccess ? { addAccess: true as const } : {})
      }
    }
  }
  trips.delete(tripId)
  return first.result.ok ? { ok: false, error: BOT_SLACK_DESKTOP_ERRORS.failed } : first.result
}

/** Waits a slice for the trip to end; a replaced or unknown trip has expired. */
export async function waitConnectorTrip(
  tripId: string,
  signal?: AbortSignal
): Promise<ConnectorTripWait> {
  const trip = trips.get(tripId)
  if (!trip) {
    return { state: 'done', result: { ok: false, error: 'expired' } }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const sliced = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, WAIT_SLICE_MS)
    signal?.addEventListener('abort', () => resolve(), { once: true })
  })
  await Promise.race([trip.ended, sliced])
  clearTimeout(timer)
  return trip.result ? { state: 'done', result: trip.result } : { state: 'waiting' }
}
