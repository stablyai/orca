import { Platform } from 'react-native'
import { connect, type ConnectOptions } from './rpc-client'
import { resolvePairingHostIdentity, savePairedHost } from './host-store'
import type { HostProfile, PairingOffer } from './types'
import { isPairingRelayRpcUnavailable } from './pairing-relay-rpc-unavailable'
import {
  relayCredentialProvision,
  relayPairingEndpointsRead
} from './mobile-relay-pairing-operations'
import {
  createMobileRelayPairingJournal,
  type MobileRelayPairingJournal
} from './mobile-relay-pairing-journal'
import {
  clearMobileRelayPairingJournal,
  saveMobileRelayPairingJournal,
  updateMobileRelayPairingJournal
} from './mobile-relay-pairing-journal-store'
import {
  promotePairingJournalCredential,
  writeMobileRelayCredentialBundle
} from './mobile-relay-credential-bundle'
import {
  connectMobileRelayForPairing,
  type PairingCandidateClient
} from './mobile-relay-physical-client'
import { racePairingCandidates, type PairingCandidate } from './pairing-candidate-race'
import { attributePairingLogPath } from './pairing-log-path'
import { resolvePairingInviteThroughDirector } from './mobile-relay-invite-director'
import { createRecoveringPairingRelayCandidate } from './pairing-relay-candidate'
import { createPairingRelayLogger } from './pairing-relay-log'
import { redactSocketEndpoint } from './socket-event-debug'
import { assertCommittedInstall, relayHost } from './pairing-relay-host'
import { recordHostDescriptorFromStatus } from './host-descriptor-recorder'
import type { HostStatusReply } from './host-status-reply-schema'

export type PreProfilePairingAttempt = {
  readonly result: Promise<{ hostId: string }>
  readonly timedOut: boolean
  dispose(): void
}

type Dependencies = {
  connectDirect: typeof connect
  connectRelay: typeof connectMobileRelayForPairing
  resolveInviteDirector: typeof resolvePairingInviteThroughDirector
  resolveHostIdentity: typeof resolvePairingHostIdentity
  saveHost: typeof savePairedHost
  saveJournal: typeof saveMobileRelayPairingJournal
  updateJournal: typeof updateMobileRelayPairingJournal
  clearJournal: typeof clearMobileRelayPairingJournal
  writeCredentialBundle: typeof writeMobileRelayCredentialBundle
  recordDescriptorFromStatus: typeof recordHostDescriptorFromStatus
  now: () => number
  platform: string
}

const defaultDependencies: Dependencies = {
  connectDirect: connect,
  connectRelay: connectMobileRelayForPairing,
  resolveInviteDirector: resolvePairingInviteThroughDirector,
  resolveHostIdentity: resolvePairingHostIdentity,
  saveHost: savePairedHost,
  saveJournal: saveMobileRelayPairingJournal,
  updateJournal: updateMobileRelayPairingJournal,
  clearJournal: clearMobileRelayPairingJournal,
  writeCredentialBundle: writeMobileRelayCredentialBundle,
  recordDescriptorFromStatus: recordHostDescriptorFromStatus,
  now: Date.now,
  platform: Platform.OS
}

export function startPreProfilePairing(args: {
  offer: PairingOffer
  timeoutMs: number
  connectOptions?: ConnectOptions
  dependencies?: Partial<Dependencies>
}): PreProfilePairingAttempt {
  const dependencies = { ...defaultDependencies, ...args.dependencies }
  const clients = new Set<PairingCandidateClient>()
  let disposed = false
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    for (const client of clients) {
      client.close()
    }
    clients.clear()
  }

  timer = setTimeout(() => {
    timedOut = true
    dispose()
  }, args.timeoutMs)

  const result = runPairing(args.offer, args.connectOptions, dependencies, clients, () => disposed)
    .catch((error: unknown) => {
      if (timedOut) {
        throw new Error('mobile pairing timed out')
      }
      throw error
    })
    .finally(() => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      for (const client of clients) {
        client.close()
      }
      clients.clear()
    })

  return {
    result,
    get timedOut() {
      return timedOut
    },
    dispose
  }
}

async function runPairing(
  offer: PairingOffer,
  connectOptions: ConnectOptions | undefined,
  dependencies: Dependencies,
  clients: Set<PairingCandidateClient>,
  isDisposed: () => boolean
): Promise<{ hostId: string }> {
  const now = dependencies.now()
  // Why: every pairing artifact must share the preserved host id so re-pairing
  // updates one card instead of publishing a second identity (STA-1840).
  const { id: hostId, name: hostName } = await dependencies.resolveHostIdentity(
    offer.publicKeyB64,
    `host-${now}`
  )
  assertActive(isDisposed)
  let journal: MobileRelayPairingJournal | null = null
  if (offer.relay && dependencies.platform !== 'web') {
    journal = createMobileRelayPairingJournal({
      offer: { ...offer, relay: offer.relay },
      hostId,
      hostName,
      now
    })
    await dependencies.saveJournal(journal)
    assertActive(isDisposed)
  }

  const directClient = dependencies.connectDirect(
    offer.endpoint,
    offer.deviceToken,
    offer.publicKeyB64,
    { ...connectOptions, onLog: attributePairingLogPath('direct', connectOptions?.onLog) }
  )
  clients.add(directClient)
  const candidates: PairingCandidate[] = [{ path: 'direct', client: directClient }]
  const log = createPairingRelayLogger(connectOptions?.onLog)
  if (journal) {
    log(
      'info',
      'Relay: pairing candidate started',
      redactSocketEndpoint(journal.metadata.relay.cellUrl)
    )
    const relayClient = createRecoveringPairingRelayCandidate({
      journal,
      connect: (relay, onLog) =>
        dependencies.connectRelay({
          relay,
          deviceToken: offer.deviceToken,
          desktopPublicKeyB64: offer.publicKeyB64,
          onLog
        }),
      resolveDirector: (relay) => dependencies.resolveInviteDirector({ relay }),
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
        await dependencies.updateJournal(journal.metadata.journalId, () => journal!.metadata)
      },
      now: dependencies.now,
      onLog: attributePairingLogPath('relay', connectOptions?.onLog)
    })
    clients.add(relayClient)
    candidates.push({ path: 'relay', client: relayClient })
  }
  const winner = await racePairingCandidates(candidates)
  log('success', 'Pairing path selected', `winner: ${winner.path}`)
  assertActive(isDisposed)

  if (!journal) {
    await dependencies.saveHost(baseHost(offer, hostId, hostName, now))
    recordWinnerDescriptor(dependencies, hostId, winner.status)
    return { hostId }
  }

  journal = {
    ...journal,
    metadata: {
      ...journal.metadata,
      winner: winner.path,
      authorizationMode: winner.path === 'direct' ? 'authenticated-direct' : 'relay-basis'
    }
  }
  await dependencies.updateJournal(journal.metadata.journalId, () => journal!.metadata)
  const provision = await relayCredentialProvision.request(winner.client, {
    reqId: journal.metadata.installReqId,
    newResumeTokenHash: journal.metadata.pendingResumeTokenHash
  })
  if (isPairingRelayRpcUnavailable(provision)) {
    if (winner.path !== 'direct') {
      throw new Error('relay pairing RPC unavailable after relay path authentication')
    }
    // Why: this commits a LAN-only host instead of failing, so the refusal code is the only
    // record of why the phone never got a relay endpoint.
    log('info', 'Relay: desktop will not serve relay pairing', provision.error.code)
    await dependencies.saveHost(baseHost(offer, hostId, hostName, now))
    await dependencies.clearJournal(journal.metadata.journalId)
    recordWinnerDescriptor(dependencies, hostId, winner.status)
    return { hostId }
  }
  const installed = relayCredentialProvision.interpret(provision)
  const endpointsReply = await relayPairingEndpointsRead.request(winner.client, {
    installReqId: journal.metadata.installReqId
  })
  const endpoints = relayPairingEndpointsRead.interpret(endpointsReply)
  assertCommittedInstall(endpoints.installStatus, installed)
  if (!endpoints.relay) {
    throw new Error('desktop returned no relay endpoint after credential install')
  }
  assertActive(isDisposed)
  await dependencies.writeCredentialBundle(promotePairingJournalCredential({ journal, installed }))
  await dependencies.saveHost(relayHost(journal, endpoints.relay))
  await dependencies.clearJournal(journal.metadata.journalId)
  recordWinnerDescriptor(dependencies, hostId, winner.status)
  return { hostId }
}

/**
 * Why after the save: the saved row starts as its existing name (or "Host N") and the descriptor
 * writer adopt-renames it to the desktop's machine name in the same serialized store chain, so a
 * load issued after pairing returns the desktop-reported name. A recording failure is swallowed —
 * descriptor upkeep must never fail a pairing that already saved.
 */
function recordWinnerDescriptor(
  dependencies: Dependencies,
  hostId: string,
  status: HostStatusReply | null
): void {
  if (!status) {
    return
  }
  try {
    dependencies.recordDescriptorFromStatus(hostId, status)
  } catch {
    // Best-effort bookkeeping; the host is already saved.
  }
}

function baseHost(
  offer: PairingOffer,
  hostId: string,
  name: string,
  lastConnected: number
): HostProfile {
  return {
    id: hostId,
    name,
    endpoint: offer.endpoint,
    deviceToken: offer.deviceToken,
    publicKeyB64: offer.publicKeyB64,
    lastConnected
  }
}

function assertActive(isDisposed: () => boolean): void {
  if (isDisposed()) {
    throw new Error('mobile pairing cancelled')
  }
}
