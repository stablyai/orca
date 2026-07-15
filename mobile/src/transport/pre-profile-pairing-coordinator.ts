import { Platform } from 'react-native'
import {
  DeviceCredentialInstalledSchema,
  PairingGetEndpointsResultSchema,
  type DeviceCredentialInstalled,
  type MobileRelayEndpoint
} from '../../../src/shared/mobile-relay-credential-contract'
import { connect, type ConnectOptions } from './rpc-client'
import { getNextHostName, saveHost } from './host-store'
import type { HostProfile, PairingOffer, RpcResponse } from './types'
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
import { resolvePairingInviteThroughDirector } from './mobile-relay-invite-director'
import { createRecoveringPairingRelayCandidate } from './pairing-relay-candidate'

export type PreProfilePairingAttempt = {
  readonly result: Promise<{ hostId: string }>
  readonly timedOut: boolean
  dispose(): void
}

type Dependencies = {
  connectDirect: typeof connect
  connectRelay: typeof connectMobileRelayForPairing
  resolveInviteDirector: typeof resolvePairingInviteThroughDirector
  getNextHostName: typeof getNextHostName
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
  connectRelay: connectMobileRelayForPairing,
  resolveInviteDirector: resolvePairingInviteThroughDirector,
  getNextHostName,
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
  const hostId = `host-${now}`
  const hostName = await dependencies.getNextHostName()
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
    connectOptions
  )
  clients.add(directClient)
  const candidates: PairingCandidate[] = [{ path: 'direct', client: directClient }]
  if (journal) {
    const relayClient = createRecoveringPairingRelayCandidate({
      journal,
      connect: (relay) =>
        dependencies.connectRelay({
          relay,
          deviceToken: offer.deviceToken,
          desktopPublicKeyB64: offer.publicKeyB64
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
      now: dependencies.now
    })
    clients.add(relayClient)
    candidates.push({ path: 'relay', client: relayClient })
  }
  const winner = await racePairingCandidates(candidates)
  assertActive(isDisposed)

  if (!journal) {
    await dependencies.saveHost(baseHost(offer, hostId, hostName, now))
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

function relayHost(journal: MobileRelayPairingJournal, relay: MobileRelayEndpoint): HostProfile {
  const host = journal.metadata.host
  return {
    ...host,
    deviceToken: journal.secrets.deviceToken,
    endpoints: [
      { id: 'direct-primary', kind: 'lan', url: host.endpoint },
      { id: 'relay-primary', kind: 'relay', url: relayWebSocketUrl(relay) }
    ],
    relayHostId: relay.relayHostId,
    relay
  }
}

function relayWebSocketUrl(relay: MobileRelayEndpoint): string {
  const url = new URL(relay.cellUrl)
  url.protocol = 'wss:'
  url.pathname = `/v1/connect/${encodeURIComponent(relay.relayHostId)}`
  return url.toString()
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
