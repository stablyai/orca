import {
  DeviceCredentialInstalledSchema,
  PairingGetEndpointsResultSchema,
  type DeviceCredentialInstalled,
  type MobileRelayEndpoint
} from '../../../src/shared/mobile-relay-credential-contract'
import { promotePairingJournalCredential } from './mobile-relay-credential-bundle'
import type { MobileRelayPairingJournal } from './mobile-relay-pairing-journal'
import type { PairingCandidate } from './pairing-candidate-race'
import type { PairingStageReporter } from './pairing-stage'
import type { PreProfilePairingFlowDependencies } from './pre-profile-pairing-flow'
import type { HostProfile, PairingOffer, RpcResponse } from './types'

export async function reconcileRelayPairing(args: {
  journal: MobileRelayPairingJournal
  winner: PairingCandidate
  dependencies: Pick<PreProfilePairingFlowDependencies, 'updateJournal' | 'writeCredentialBundle'>
  stageReporter: PairingStageReporter
  isDisposed: () => boolean
  offer: PairingOffer
}): Promise<HostProfile> {
  const { journal, winner } = args
  args.stageReporter.begin('relay_reconciliation', `path: ${winner.path}`)
  const reconciledJournal = {
    ...journal,
    metadata: {
      ...journal.metadata,
      winner: winner.path,
      authorizationMode: winner.path === 'direct' ? 'authenticated-direct' : 'relay-basis'
    }
  } satisfies MobileRelayPairingJournal
  await args.dependencies.updateJournal(
    reconciledJournal.metadata.journalId,
    () => reconciledJournal.metadata
  )
  const provision = await winner.client.sendRequest('pairing.provisionRelay', {
    reqId: reconciledJournal.metadata.installReqId,
    newResumeTokenHash: reconciledJournal.metadata.pendingResumeTokenHash
  })
  if (isMethodNotFound(provision)) {
    if (winner.path !== 'direct') {
      throw new PairingRpcResponseError(
        'relay_pairing_unavailable',
        'relay pairing RPC unavailable after relay path authentication'
      )
    }
    args.stageReporter.complete('relay_reconciliation', 'direct-only compatibility path')
    return createDirectPairingHost(
      args.offer,
      reconciledJournal.metadata.host.id,
      reconciledJournal.metadata.host.name,
      reconciledJournal.metadata.host.lastConnected
    )
  }
  const installed = DeviceCredentialInstalledSchema.parse(requireSuccess(provision))
  const endpoints = PairingGetEndpointsResultSchema.parse(
    requireSuccess(
      await winner.client.sendRequest('pairing.getEndpoints', {
        installReqId: reconciledJournal.metadata.installReqId
      })
    )
  )
  assertCommittedInstall(endpoints.installStatus, installed)
  if (!endpoints.relay) {
    throw new PairingRpcResponseError(
      'relay_endpoint_missing',
      'desktop returned no relay endpoint after credential install'
    )
  }
  assertActive(args.isDisposed)
  await args.dependencies.writeCredentialBundle(
    promotePairingJournalCredential({ journal: reconciledJournal, installed })
  )
  args.stageReporter.complete('relay_reconciliation', `path: ${winner.path}`)
  return createRelayPairingHost(reconciledJournal, endpoints.relay)
}

export function createDirectPairingHost(
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

function createRelayPairingHost(
  journal: MobileRelayPairingJournal,
  relay: MobileRelayEndpoint
): HostProfile {
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
    throw new PairingRpcResponseError(response.error.code, response.error.message)
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
    throw new PairingRpcResponseError(
      'relay_install_unverified',
      'relay credential install was not authoritatively reconciled'
    )
  }
}

function assertActive(isDisposed: () => boolean): void {
  if (isDisposed()) {
    throw new PairingRpcResponseError('pairing_cancelled', 'mobile pairing cancelled')
  }
}

export class PairingRpcResponseError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PairingRpcResponseError'
    this.code = code
  }
}
