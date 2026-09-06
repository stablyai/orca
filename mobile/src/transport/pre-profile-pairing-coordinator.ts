import { Platform } from 'react-native'
import {
  DeviceCredentialInstalledSchema,
  PairingGetEndpointsResultSchema,
  type DeviceCredentialInstalled
} from '../../../src/shared/mobile-relay-credential-contract'
import { connect, type ConnectOptions } from './rpc-client'
import { openIrohRpcClient } from './mobile-iroh-physical-link'
import { resolvePairingHostIdentity, saveHost } from './host-store'
import { baseHost, relayHost } from './paired-host-profile'
import type { PairingOffer, RpcResponse } from './types'
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

export type PreProfilePairingAttempt = {
  readonly result: Promise<{ hostId: string }>
  readonly timedOut: boolean
  dispose(): void
}

type Dependencies = {
  connectDirect: typeof connect
  connectIroh: typeof openIrohRpcClient
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

const defaultDependencies: Dependencies = {
  connectDirect: connect,
  connectIroh: openIrohRpcClient,
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

  // Why: iroh offers pair over iroh itself — it reaches the desktop on LAN and
  // cellular alike, so the ws dial (and its failure noise) is skipped entirely
  // unless iroh is unavailable on this platform (Android stub / Expo Go).
  let irohPairingClient: ReturnType<typeof openIrohRpcClient> = null
  const irohLog = attributePairingLogPath('iroh', connectOptions?.onLog)
  if (offer.iroh && !journal && dependencies.platform === 'ios') {
    irohPairingClient = dependencies.connectIroh({
      desktopEndpointId: offer.iroh.endpointId,
      ...(offer.iroh.relayUrl || offer.iroh.directAddresses?.length
        ? {
            dialHints: {
              ...(offer.iroh.relayUrl ? { relayUrl: offer.iroh.relayUrl } : {}),
              ...(offer.iroh.directAddresses?.length
                ? { directAddresses: offer.iroh.directAddresses }
                : {})
            }
          }
        : {}),
      deviceToken: offer.deviceToken,
      publicKeyB64: offer.publicKeyB64,
      ...(irohLog ? { onLog: irohLog } : {})
    })
  }

  const candidates: PairingCandidate[] = []
  if (irohPairingClient) {
    clients.add(irohPairingClient)
    candidates.push({ path: 'iroh', client: irohPairingClient })
  } else {
    const directClient = dependencies.connectDirect(
      offer.endpoint,
      offer.deviceToken,
      offer.publicKeyB64,
      { ...connectOptions, onLog: attributePairingLogPath('direct', connectOptions?.onLog) }
    )
    clients.add(directClient)
    candidates.push({ path: 'direct', client: directClient })
  }
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
    return { hostId }
  }
  if (winner.path === 'iroh') {
    // Why: the iroh candidate is only raced for journal-less offers; a journal
    // implies direct/relay, and the metadata schema only records those paths.
    throw new Error('iroh pairing path cannot carry a relay journal')
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
  const provision = await winner.client.sendRequest('pairing.provisionRelay', {
    reqId: journal.metadata.installReqId,
    newResumeTokenHash: journal.metadata.pendingResumeTokenHash
  })
  if (isMethodNotFound(provision)) {
    if (winner.path !== 'direct') {
      throw new Error('relay pairing RPC unavailable after relay path authentication')
    }
    await dependencies.saveHost(baseHost(offer, hostId, hostName, now))
    await dependencies.clearJournal(journal.metadata.journalId)
    return { hostId }
  }
  const installed = DeviceCredentialInstalledSchema.parse(requireSuccess(provision))
  const endpoints = PairingGetEndpointsResultSchema.parse(
    requireSuccess(
      await winner.client.sendRequest('pairing.getEndpoints', {
        installReqId: journal.metadata.installReqId
      })
    )
  )
  assertCommittedInstall(endpoints.installStatus, installed)
  if (!endpoints.relay) {
    throw new Error('desktop returned no relay endpoint after credential install')
  }
  assertActive(isDisposed)
  await dependencies.writeCredentialBundle(promotePairingJournalCredential({ journal, installed }))
  await dependencies.saveHost(relayHost(journal, endpoints.relay))
  await dependencies.clearJournal(journal.metadata.journalId)
  return { hostId }
}

function requireSuccess(response: RpcResponse): unknown {
  if (!response.ok) {
    throw new Error(`${response.error.code}: ${response.error.message}`)
  }
  return response.result
}

function isMethodNotFound(response: RpcResponse): boolean {
  return !response.ok && response.error.code === 'method_not_found'
}

function assertCommittedInstall(
  status:
    | { state: 'not-found' }
    | { state: 'committed'; result: DeviceCredentialInstalled }
    | undefined,
  installed: DeviceCredentialInstalled
): void {
  if (
    !status ||
    status.state !== 'committed' ||
    JSON.stringify(status.result) !== JSON.stringify(installed)
  ) {
    throw new Error('relay credential install was not authoritatively reconciled')
  }
}

function assertActive(isDisposed: () => boolean): void {
  if (isDisposed()) {
    throw new Error('mobile pairing cancelled')
  }
}
