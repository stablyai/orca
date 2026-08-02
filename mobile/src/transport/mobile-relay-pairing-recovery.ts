import { Platform } from 'react-native'
import {
  DeviceCredentialInstalledSchema,
  PairingGetEndpointsResultSchema,
  type DeviceCredentialInstalled,
  type MobileRelayEndpoint
} from '../../../src/shared/mobile-relay-credential-contract'
import type { PairingRelay } from '../../../src/shared/mobile-relay-pairing-offer'
import { loadHosts, saveHost } from './host-store'
import {
  promotePairingJournalCredential,
  readMobileRelayCredentialBundle,
  writeMobileRelayCredentialBundle,
  type MobileRelayCredentialBundle
} from './mobile-relay-credential-bundle'
import { resolvePairingInviteThroughDirector } from './mobile-relay-invite-director'
import type { MobileRelayPairingJournal } from './mobile-relay-pairing-journal'
import {
  clearMobileRelayPairingJournal,
  loadMobileRelayPairingJournal,
  updateMobileRelayPairingJournal
} from './mobile-relay-pairing-journal-store'
import {
  connectMobileRelayForPairing,
  type PairingCandidateClient
} from './mobile-relay-physical-client'
import { createRecoveringPairingRelayCandidate } from './pairing-relay-candidate'
import type { HostProfile, RpcResponse } from './types'

export type MobileRelayPairingRecoveryResult = 'none' | 'recovered' | 'deferred'

type RecoveryDependencies = {
  loadJournal: typeof loadMobileRelayPairingJournal
  updateJournal: typeof updateMobileRelayPairingJournal
  clearJournal: typeof clearMobileRelayPairingJournal
  readCredentialBundle: typeof readMobileRelayCredentialBundle
  writeCredentialBundle: typeof writeMobileRelayCredentialBundle
  loadHosts: typeof loadHosts
  saveHost: typeof saveHost
  connectRelay: typeof connectMobileRelayForPairing
  resolveInviteDirector: typeof resolvePairingInviteThroughDirector
  now: () => number
  platform: string
}

const defaultDependencies: RecoveryDependencies = {
  loadJournal: loadMobileRelayPairingJournal,
  updateJournal: updateMobileRelayPairingJournal,
  clearJournal: clearMobileRelayPairingJournal,
  readCredentialBundle: readMobileRelayCredentialBundle,
  writeCredentialBundle: writeMobileRelayCredentialBundle,
  loadHosts,
  saveHost,
  connectRelay: connectMobileRelayForPairing,
  resolveInviteDirector: resolvePairingInviteThroughDirector,
  now: Date.now,
  platform: Platform.OS
}

let recoveryPromise: Promise<MobileRelayPairingRecoveryResult> | null = null

export function recoverMobileRelayPairing(
  overrides: Partial<RecoveryDependencies> = {}
): Promise<MobileRelayPairingRecoveryResult> {
  if (recoveryPromise) {
    return recoveryPromise
  }
  const dependencies = { ...defaultDependencies, ...overrides }
  recoveryPromise = runRecovery(dependencies).finally(() => {
    recoveryPromise = null
  })
  return recoveryPromise
}

async function runRecovery(
  dependencies: RecoveryDependencies
): Promise<MobileRelayPairingRecoveryResult> {
  if (dependencies.platform === 'web') {
    return 'none'
  }
  let journal: MobileRelayPairingJournal | null
  try {
    journal = await dependencies.loadJournal()
  } catch {
    return 'deferred'
  }
  if (!journal) {
    return 'none'
  }
  const bundle = await dependencies.readCredentialBundle(journal.metadata.host.id).catch(() => null)
  const hosts = await dependencies.loadHosts().catch(() => [])
  const existing = hosts.find(({ id }) => id === journal!.metadata.host.id)
  if (existing?.relayHostId === journal.metadata.relay.relayHostId && bundle) {
    await dependencies.clearJournal(journal.metadata.journalId)
    return 'recovered'
  }

  const credentials = recoveryCredentials(journal, bundle, dependencies.now())
  for (const credential of credentials) {
    let client: PairingCandidateClient | null = null
    try {
      client =
        credential.kind === 'invite'
          ? createInviteClient(journal, dependencies, (next) => {
              journal = next
            })
          : dependencies.connectRelay({
              relay: pairingRelay(journal),
              deviceToken: journal.secrets.deviceToken,
              desktopPublicKeyB64: journal.metadata.host.publicKeyB64,
              credential: credential.token,
              expectedCredentialKind: 'resume'
            })
      const endpoints = await getRecoveryStatus(client, journal, credential.kind)
      if (endpoints.installStatus?.state === 'committed') {
        await publishCommitted(journal, endpoints, dependencies)
        return 'recovered'
      }
      if (credential.kind === 'invite' && endpoints.installStatus?.state === 'not-found') {
        journal = await transitionToInviteAuthorization(journal, dependencies)
        const installed = DeviceCredentialInstalledSchema.parse(
          requireSuccess(
            await client.sendRequest('pairing.provisionRelay', {
              reqId: journal.metadata.installReqId,
              newResumeTokenHash: journal.metadata.pendingResumeTokenHash
            })
          )
        )
        const reconciled = await getRecoveryStatus(client, journal, 'invite')
        assertCommitted(reconciled, installed)
        await publishCommitted(journal, reconciled, dependencies)
        return 'recovered'
      }
    } catch {
      // Why: ambiguous pairing state advances only by credential priority and
      // authoritative status; a transport failure never rewrites the journal.
    } finally {
      client?.close()
    }
  }
  return 'deferred'
}

function recoveryCredentials(
  journal: MobileRelayPairingJournal,
  bundle: MobileRelayCredentialBundle | null,
  now: number
): { kind: 'resume' | 'invite'; token: string }[] {
  const credentials: { kind: 'resume' | 'invite'; token: string }[] = [
    { kind: 'resume', token: journal.secrets.pendingResumeToken }
  ]
  if (bundle?.current.token && bundle.current.token !== journal.secrets.pendingResumeToken) {
    credentials.push({ kind: 'resume', token: bundle.current.token })
  }
  if (journal.metadata.relay.inviteExpiresAt > now) {
    credentials.push({ kind: 'invite', token: journal.secrets.inviteToken })
  }
  return credentials
}

function createInviteClient(
  journal: MobileRelayPairingJournal,
  dependencies: RecoveryDependencies,
  replaceJournal: (journal: MobileRelayPairingJournal) => void
): PairingCandidateClient {
  return createRecoveringPairingRelayCandidate({
    journal,
    connect: (relay) =>
      dependencies.connectRelay({
        relay,
        deviceToken: journal.secrets.deviceToken,
        desktopPublicKeyB64: journal.metadata.host.publicKeyB64
      }),
    resolveDirector: (relay) => dependencies.resolveInviteDirector({ relay }),
    persistMove: async (relay) => {
      const next = {
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
      await dependencies.updateJournal(journal.metadata.journalId, () => next.metadata)
      replaceJournal(next)
    },
    now: dependencies.now
  })
}

async function getRecoveryStatus(
  client: PairingCandidateClient,
  journal: MobileRelayPairingJournal,
  kind: 'resume' | 'invite'
) {
  return PairingGetEndpointsResultSchema.parse(
    requireSuccess(
      await client.sendRequest('pairing.getEndpoints', {
        installReqId: journal.metadata.installReqId,
        ...(kind === 'resume' ? { resumeConfirmReqId: journal.metadata.resumeConfirmReqId } : {})
      })
    )
  )
}

async function transitionToInviteAuthorization(
  journal: MobileRelayPairingJournal,
  dependencies: RecoveryDependencies
): Promise<MobileRelayPairingJournal> {
  const next: MobileRelayPairingJournal = {
    ...journal,
    metadata: {
      ...journal.metadata,
      winner: 'relay',
      authorizationMode: 'relay-basis'
    }
  }
  // Why: the branch change becomes durable only after authoritative not-found.
  await dependencies.updateJournal(journal.metadata.journalId, () => next.metadata)
  return next
}

async function publishCommitted(
  journal: MobileRelayPairingJournal,
  endpoints: ReturnType<typeof PairingGetEndpointsResultSchema.parse>,
  dependencies: RecoveryDependencies
): Promise<void> {
  if (endpoints.installStatus?.state !== 'committed' || !endpoints.relay) {
    throw new Error('relay pairing recovery was not committed')
  }
  const installed = endpoints.installStatus.result
  const reconciledJournal: MobileRelayPairingJournal = {
    ...journal,
    metadata: {
      ...journal.metadata,
      winner: installed.authorizationMode === 'authenticated-direct' ? 'direct' : 'relay',
      authorizationMode: installed.authorizationMode
    }
  }
  if (journal.metadata.authorizationMode !== installed.authorizationMode) {
    await dependencies.updateJournal(journal.metadata.journalId, () => reconciledJournal.metadata)
  }
  await dependencies.writeCredentialBundle(
    promotePairingJournalCredential({ journal: reconciledJournal, installed })
  )
  await dependencies.saveHost(relayHost(reconciledJournal, endpoints.relay))
  await dependencies.clearJournal(journal.metadata.journalId)
}

function relayHost(journal: MobileRelayPairingJournal, relay: MobileRelayEndpoint): HostProfile {
  const host = journal.metadata.host
  const url = new URL(relay.cellUrl)
  url.protocol = 'wss:'
  url.pathname = `/v1/connect/${encodeURIComponent(relay.relayHostId)}`
  return {
    ...host,
    deviceToken: journal.secrets.deviceToken,
    endpoints: [
      { id: 'direct-primary', kind: 'lan', url: host.endpoint },
      { id: 'relay-primary', kind: 'relay', url: url.toString() }
    ],
    relayHostId: relay.relayHostId,
    relay
  }
}

function pairingRelay(journal: MobileRelayPairingJournal): PairingRelay {
  return { ...journal.metadata.relay, inviteToken: journal.secrets.inviteToken }
}

function requireSuccess(response: RpcResponse): unknown {
  if (!response.ok) {
    throw new Error(`${response.error.code}: ${response.error.message}`)
  }
  return response.result
}

function assertCommitted(
  endpoints: ReturnType<typeof PairingGetEndpointsResultSchema.parse>,
  installed: DeviceCredentialInstalled
): void {
  if (
    endpoints.installStatus?.state !== 'committed' ||
    JSON.stringify(endpoints.installStatus.result) !== JSON.stringify(installed)
  ) {
    throw new Error('relay pairing recovery install was not authoritatively committed')
  }
}

/** Test-only: clear the startup single-flight between cases. */
export function resetMobileRelayPairingRecoveryForTests(): void {
  recoveryPromise = null
}
