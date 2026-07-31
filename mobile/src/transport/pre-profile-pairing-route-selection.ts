import type { MobileRelayPairingJournal } from './mobile-relay-pairing-journal'
import type {
  connectMobileRelayForPairing,
  PairingCandidateClient
} from './mobile-relay-physical-client'
import { normalizePairingEndpoints, type PairingOffer } from './types'
import {
  PAIR_CONNECT_TIMEOUT_MS,
  resolvePairDialPlan,
  resolvePairRouteAuthTimeout
} from './pairing-connection-attempt'
import {
  selectOrderedPairingCandidate,
  type OrderedPairingCandidate,
  type PairingCandidate
} from './ordered-pairing-candidate'
import { racePairingCandidates } from './pairing-candidate-race'
import { createRecoveringPairingRelayCandidate } from './pairing-relay-candidate'
import type { connect, ConnectOptions } from './rpc-client'
import type { resolvePairingInviteThroughDirector } from './mobile-relay-invite-director'
import type { updateMobileRelayPairingJournal } from './mobile-relay-pairing-journal-store'

type RouteSelectionDependencies = {
  connectDirect: typeof connect
  connectRelay: typeof connectMobileRelayForPairing
  resolveInviteDirector: typeof resolvePairingInviteThroughDirector
  updateJournal: typeof updateMobileRelayPairingJournal
  now: () => number
}

export async function selectPreProfilePairingRoute(args: {
  offer: PairingOffer
  journal: MobileRelayPairingJournal | null
  connectOptions: ConnectOptions | undefined
  dependencies: RouteSelectionDependencies
  clients: Set<PairingCandidateClient>
  isDisposed: () => boolean
  pairingDeadlineAt: number
}): Promise<{ winner: PairingCandidate; journal: MobileRelayPairingJournal | null }> {
  // Why: unmarked offers must retain the released direct/Relay race; only the
  // explicit pairing marker opts a new mobile build into sequential routing.
  const orderedRoutes = args.offer.routeOrder === 1
  const normalizedDirectUrls = orderedRoutes
    ? normalizePairingEndpoints(args.offer.endpoint, args.offer.endpoints)
    : [args.offer.endpoint]
  const dialPlan = orderedRoutes
    ? resolvePairDialPlan(
        normalizedDirectUrls,
        Math.max(1, args.pairingDeadlineAt - args.dependencies.now())
      )
    : { endpoints: normalizedDirectUrls, connectTimeoutMs: PAIR_CONNECT_TIMEOUT_MS }
  const directUrls = dialPlan.endpoints
  const candidates: OrderedPairingCandidate[] = directUrls.map((endpoint) => ({
    path: 'direct',
    url: endpoint,
    open: () =>
      args.dependencies.connectDirect(endpoint, args.offer.deviceToken, args.offer.publicKeyB64, {
        ...args.connectOptions,
        endpoints: [endpoint],
        lastGoodEndpoint: null,
        connectTimeoutMs: Math.min(
          args.connectOptions?.connectTimeoutMs ?? dialPlan.connectTimeoutMs,
          dialPlan.connectTimeoutMs
        )
      })
  }))
  let journal = args.journal
  if (journal) {
    const relayIndex = Math.max(
      0,
      Math.min(
        directUrls.length,
        orderedRoutes ? (args.offer.relayPreferenceIndex ?? directUrls.length) : directUrls.length
      )
    )
    candidates.splice(relayIndex, 0, {
      path: 'relay',
      open: () =>
        createRecoveringPairingRelayCandidate({
          journal: journal!,
          connect: (relay) =>
            args.dependencies.connectRelay({
              relay,
              deviceToken: args.offer.deviceToken,
              desktopPublicKeyB64: args.offer.publicKeyB64
            }),
          resolveDirector: (relay) => args.dependencies.resolveInviteDirector({ relay }),
          persistMove: async (relay) => {
            journal = {
              ...journal!,
              metadata: {
                ...journal!.metadata,
                relay: {
                  ...journal!.metadata.relay,
                  cellUrl: relay.cellUrl,
                  assignmentEpoch: relay.assignmentEpoch
                }
              }
            }
            await args.dependencies.updateJournal(
              journal.metadata.journalId,
              () => journal!.metadata
            )
          },
          now: args.dependencies.now
        })
    })
  }

  const winner = orderedRoutes
    ? await selectOrderedPairingCandidate(
        candidates,
        resolvePairRouteAuthTimeout(
          candidates.length,
          args.pairingDeadlineAt,
          args.dependencies.now()
        ),
        (client) => args.clients.add(client),
        args.isDisposed
      )
    : await racePairingCandidates(
        candidates.map((candidate) => {
          const client = candidate.open()
          args.clients.add(client)
          return { path: candidate.path, client, url: candidate.url }
        })
      )
  return { winner, journal }
}
