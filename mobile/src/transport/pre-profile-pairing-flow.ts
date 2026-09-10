import { Platform } from 'react-native'
import { resolvePairingHostIdentity, saveHost } from './host-store'
import { writeMobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import {
  createMobileRelayPairingJournal,
  type MobileRelayPairingJournal
} from './mobile-relay-pairing-journal'
import {
  clearMobileRelayPairingJournal,
  saveMobileRelayPairingJournal,
  updateMobileRelayPairingJournal
} from './mobile-relay-pairing-journal-store'
import { resolvePairingInviteThroughDirector } from './mobile-relay-invite-director'
import {
  connectMobileRelayForPairing,
  type PairingCandidateClient
} from './mobile-relay-physical-client'
import {
  PairingCandidateRaceError,
  racePairingCandidates,
  type PairingCandidate
} from './pairing-candidate-race'
import { attributePairingLogPath } from './pairing-log-path'
import { createRecoveringPairingRelayCandidate } from './pairing-relay-candidate'
import { createPairingRelayLogger } from './pairing-relay-log'
import type { PairingStageReporter } from './pairing-stage'
import {
  createDirectPairingHost,
  PairingRpcResponseError,
  reconcileRelayPairing
} from './pre-profile-relay-pairing-commit'
import { connect, type ConnectOptions } from './rpc-client'
import { redactSocketEndpoint } from './socket-event-debug'
import type { PairingOffer } from './types'

export type PreProfilePairingClientCommit = {
  refreshClient(hostId: string): void | Promise<void>
  commitRoute(hostId: string): void | Promise<void>
}

export type PreProfilePairingFlowDependencies = {
  connectDirect: typeof connect
  connectRelay: typeof connectMobileRelayForPairing
  resolveInviteDirector: typeof resolvePairingInviteThroughDirector
  resolveHostIdentity: typeof resolvePairingHostIdentity
  saveHost: typeof saveHost
  saveJournal: typeof saveMobileRelayPairingJournal
  updateJournal: typeof updateMobileRelayPairingJournal
  clearJournal: typeof clearMobileRelayPairingJournal
  writeCredentialBundle: typeof writeMobileRelayCredentialBundle
  now: () => number
  platform: string
}

export const defaultPreProfilePairingFlowDependencies: PreProfilePairingFlowDependencies = {
  connectDirect: connect,
  connectRelay: connectMobileRelayForPairing,
  resolveInviteDirector: resolvePairingInviteThroughDirector,
  resolveHostIdentity: resolvePairingHostIdentity,
  saveHost,
  saveJournal: saveMobileRelayPairingJournal,
  updateJournal: updateMobileRelayPairingJournal,
  clearJournal: clearMobileRelayPairingJournal,
  writeCredentialBundle: writeMobileRelayCredentialBundle,
  now: Date.now,
  platform: Platform.OS
}

export async function runPreProfilePairingFlow(args: {
  offer: PairingOffer
  clientCommit: PreProfilePairingClientCommit
  connectOptions: ConnectOptions | undefined
  dependencies: PreProfilePairingFlowDependencies
  clients: Set<PairingCandidateClient>
  stageReporter: PairingStageReporter
  isDisposed: () => boolean
}): Promise<{ hostId: string }> {
  const now = args.dependencies.now()
  const { id: hostId, name: hostName } = await args.dependencies.resolveHostIdentity(
    args.offer.publicKeyB64,
    `host-${now}`
  )
  assertActive(args.isDisposed)
  let journal = await preparePairingJournal(args, hostId, hostName, now)

  args.stageReporter.begin('transport_connection', redactSocketEndpoint(args.offer.endpoint))
  const directClient = args.dependencies.connectDirect(
    args.offer.endpoint,
    args.offer.deviceToken,
    args.offer.publicKeyB64,
    {
      ...args.connectOptions,
      onLog: attributePairingLogPath('direct', args.connectOptions?.onLog)
    }
  )
  args.clients.add(directClient)
  const candidates: PairingCandidate[] = [{ path: 'direct', client: directClient }]
  const log = createPairingRelayLogger(args.connectOptions?.onLog)
  if (journal) {
    log(
      'info',
      'Relay: pairing candidate started',
      redactSocketEndpoint(journal.metadata.relay.cellUrl)
    )
    const relayClient = createRecoveringPairingRelayCandidate({
      journal,
      connect: (relay, onLog) =>
        args.dependencies.connectRelay({
          relay,
          deviceToken: args.offer.deviceToken,
          desktopPublicKeyB64: args.offer.publicKeyB64,
          onLog
        }),
      resolveDirector: (relay) => args.dependencies.resolveInviteDirector({ relay }),
      persistMove: async (relay) => {
        if (!journal) {
          throw new PairingRpcResponseError('pairing_journal_missing', 'pairing journal missing')
        }
        const nextJournal = {
          ...journal,
          metadata: {
            ...journal.metadata,
            relay: {
              ...journal.metadata.relay,
              cellUrl: relay.cellUrl,
              assignmentEpoch: relay.assignmentEpoch
            }
          }
        }
        journal = nextJournal
        await args.dependencies.updateJournal(
          nextJournal.metadata.journalId,
          () => nextJournal.metadata
        )
      },
      now: args.dependencies.now,
      onLog: attributePairingLogPath('relay', args.connectOptions?.onLog)
    })
    args.clients.add(relayClient)
    candidates.push({ path: 'relay', client: relayClient })
  }

  const winner = await selectPairingCandidate(candidates, args.stageReporter)
  args.stageReporter.complete('transport_connection', `path: ${winner.path}`)
  args.stageReporter.complete('host_authentication', `path: ${winner.path}`)
  log('success', 'Pairing path selected', `winner: ${winner.path}`)
  assertActive(args.isDisposed)

  const persistedHost = journal
    ? await reconcileRelayPairing({
        journal,
        winner,
        dependencies: args.dependencies,
        stageReporter: args.stageReporter,
        isDisposed: args.isDisposed,
        offer: args.offer
      })
    : createDirectPairingHost(args.offer, hostId, hostName, now)

  assertActive(args.isDisposed)
  args.stageReporter.begin('profile_persistence')
  await args.dependencies.saveHost(persistedHost)
  if (journal) {
    await args.dependencies.clearJournal(journal.metadata.journalId)
  }
  args.stageReporter.complete('profile_persistence')

  assertActive(args.isDisposed)
  args.stageReporter.begin('client_refresh')
  await args.clientCommit.refreshClient(hostId)
  args.stageReporter.complete('client_refresh')

  assertActive(args.isDisposed)
  args.stageReporter.begin('route_commit')
  await args.clientCommit.commitRoute(hostId)
  args.stageReporter.complete('route_commit')
  return { hostId }
}

async function preparePairingJournal(
  args: Parameters<typeof runPreProfilePairingFlow>[0],
  hostId: string,
  hostName: string,
  now: number
): Promise<MobileRelayPairingJournal | null> {
  if (!args.offer.relay || args.dependencies.platform === 'web') {
    return null
  }
  const journal = createMobileRelayPairingJournal({
    offer: { ...args.offer, relay: args.offer.relay },
    hostId,
    hostName,
    now
  })
  await args.dependencies.saveJournal(journal)
  assertActive(args.isDisposed)
  return journal
}

async function selectPairingCandidate(
  candidates: PairingCandidate[],
  stageReporter: PairingStageReporter
): Promise<PairingCandidate> {
  try {
    return await racePairingCandidates(candidates)
  } catch (error) {
    if (error instanceof PairingCandidateRaceError && error.kind === 'response') {
      stageReporter.begin('host_authentication')
    }
    throw error
  }
}

function assertActive(isDisposed: () => boolean): void {
  if (isDisposed()) {
    throw new PairingRpcResponseError('pairing_cancelled', 'mobile pairing cancelled')
  }
}
