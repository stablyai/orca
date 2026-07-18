import { Platform } from 'react-native'
import {
  DeviceCredentialInstalledSchema,
  PairingGetEndpointsResultSchema,
  type DeviceCredentialInstalled
} from '../../../src/shared/mobile-relay-credential-contract'
import { connect, type ConnectOptions } from './rpc-client'
import { resolvePairingHostIdentity, saveHost } from './host-store'
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
import { resolvePairingInviteThroughDirector } from './mobile-relay-invite-director'
import {
  hostProfileFromPairingOffer,
  relayHostProfileFromPairing
} from './host-profile-from-pairing'
import { relayWebSocketUrl } from './mobile-access-route-order'
import { selectPreProfilePairingRoute } from './pre-profile-pairing-route-selection'

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
  const pairingDeadlineAt = dependencies.now() + args.timeoutMs
  const clients = new Set<PairingCandidateClient>()
  let disposed = false
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let rejectDeadline!: (error: Error) => void
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject
  })

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
    rejectDeadline(new Error('mobile pairing timed out'))
  }, args.timeoutMs)

  const operation = runPairing(
    args.offer,
    args.connectOptions,
    dependencies,
    clients,
    () => disposed,
    pairingDeadlineAt
  )
  // Why: closing sockets alone cannot cancel a stalled secure-store write;
  // the caller still needs a deterministic terminal result at the deadline.
  const result = Promise.race([operation, deadline]).finally(() => {
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
  isDisposed: () => boolean,
  pairingDeadlineAt: number
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

  const selection = await selectPreProfilePairingRoute({
    offer,
    journal,
    connectOptions,
    dependencies,
    clients,
    isDisposed,
    pairingDeadlineAt
  })
  const winner = selection.winner
  journal = selection.journal
  assertActive(isDisposed)

  if (!journal) {
    assertActive(isDisposed)
    await dependencies.saveHost(
      hostProfileFromPairingOffer({
        id: hostId,
        name: hostName,
        offer,
        lastConnected: now,
        lastGoodEndpoint: winner.url
      })
    )
    assertActive(isDisposed)
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
  assertActive(isDisposed)
  const provision = await winner.client.sendRequest('pairing.provisionRelay', {
    reqId: journal.metadata.installReqId,
    newResumeTokenHash: journal.metadata.pendingResumeTokenHash
  })
  assertActive(isDisposed)
  if (isMethodNotFound(provision)) {
    if (winner.path !== 'direct') {
      throw new Error('relay pairing RPC unavailable after relay path authentication')
    }
    assertActive(isDisposed)
    await dependencies.saveHost(
      hostProfileFromPairingOffer({
        id: hostId,
        name: hostName,
        offer,
        lastConnected: now,
        lastGoodEndpoint: winner.url
      })
    )
    assertActive(isDisposed)
    await dependencies.clearJournal(journal.metadata.journalId)
    assertActive(isDisposed)
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
  assertActive(isDisposed)
  assertCommittedInstall(endpoints.installStatus, installed)
  if (!endpoints.relay) {
    throw new Error('desktop returned no relay endpoint after credential install')
  }
  assertActive(isDisposed)
  await dependencies.writeCredentialBundle(promotePairingJournalCredential({ journal, installed }))
  assertActive(isDisposed)
  await dependencies.saveHost(
    relayHostProfileFromPairing(
      journal,
      endpoints.relay,
      winner.path === 'relay' ? relayWebSocketUrl(endpoints.relay) : winner.url
    )
  )
  assertActive(isDisposed)
  await dependencies.clearJournal(journal.metadata.journalId)
  assertActive(isDisposed)
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
