import * as ExpoCrypto from 'expo-crypto'
import {
  DeviceCredentialInstalledSchema,
  PairingGetEndpointsResultSchema,
  type DeviceCredentialInstalled,
  type PairingGetEndpointsResult
} from '../../../src/shared/mobile-relay-credential-contract'
import { MobileRelayUpgradeHostRemovedError, saveExistingHostRelayUpgrade } from './host-store'
import { persistRelayHost } from './mobile-endpoint-supervisor-support'
import {
  MobileRelayCredentialBundleSchema,
  deleteMobileRelayCredentialBundle,
  writeMobileRelayCredentialBundle,
  type MobileRelayCredentialBundle
} from './mobile-relay-credential-bundle'
import {
  createMobileRelayDirectUpgradeJournal,
  deleteMobileRelayDirectUpgradeJournal,
  readMobileRelayDirectUpgradeJournal,
  writeMobileRelayDirectUpgradeJournal,
  type MobileRelayDirectUpgradeJournal
} from './mobile-relay-direct-upgrade-journal'
import type { RpcClient } from './rpc-client'
import type { HostProfile, RpcResponse } from './types'

export type MobileRelayDirectUpgradeResult = {
  host: HostProfile
  bundle: MobileRelayCredentialBundle
}

type Dependencies = {
  readJournal: typeof readMobileRelayDirectUpgradeJournal
  writeJournal: typeof writeMobileRelayDirectUpgradeJournal
  clearJournal: typeof deleteMobileRelayDirectUpgradeJournal
  writeBundle: typeof writeMobileRelayCredentialBundle
  saveHost: typeof saveExistingHostRelayUpgrade
  deleteBundle: typeof deleteMobileRelayCredentialBundle
  randomBytes: (length: number) => Uint8Array
}

export async function upgradeDirectMobileRelay(args: {
  client: RpcClient
  host: HostProfile
  dependencies?: Partial<Dependencies>
}): Promise<MobileRelayDirectUpgradeResult | null> {
  if (args.host.relay) {
    return null
  }
  const dependencies: Dependencies = {
    readJournal: readMobileRelayDirectUpgradeJournal,
    writeJournal: writeMobileRelayDirectUpgradeJournal,
    clearJournal: deleteMobileRelayDirectUpgradeJournal,
    writeBundle: writeMobileRelayCredentialBundle,
    saveHost: saveExistingHostRelayUpgrade,
    deleteBundle: deleteMobileRelayCredentialBundle,
    randomBytes: ExpoCrypto.getRandomBytes,
    ...args.dependencies
  }
  let journal = await dependencies.readJournal(args.host.id)
  if (!journal) {
    journal = createMobileRelayDirectUpgradeJournal(args.host.id, dependencies.randomBytes)
    // Why: the stable reqId and pending secret must survive a lost install response.
    await dependencies.writeJournal(journal)
  }

  const initial = await getEndpoints(args.client, journal.reqId)
  if (initial === 'method-not-found') {
    await dependencies.clearJournal(args.host.id)
    return null
  }
  if (initial.installStatus?.state === 'committed') {
    return publishCommitted(args.host, journal, initial, dependencies)
  }
  if (!initial.relay) {
    throw new Error('relay endpoint unavailable for direct pairing upgrade')
  }

  const provisionResponse = await args.client.sendRequest('pairing.provisionRelay', {
    reqId: journal.reqId,
    newResumeTokenHash: journal.pendingResumeTokenHash
  })
  if (isMethodNotFound(provisionResponse)) {
    await dependencies.clearJournal(args.host.id)
    return null
  }
  const installed = DeviceCredentialInstalledSchema.parse(requireSuccess(provisionResponse))
  assertDirectInstall(journal, installed)
  const reconciled = await getEndpoints(args.client, journal.reqId)
  if (reconciled === 'method-not-found') {
    throw new Error('relay endpoint reconciliation became unavailable')
  }
  assertCommitted(reconciled, installed)
  return publishCommitted(args.host, journal, reconciled, dependencies)
}

async function publishCommitted(
  host: HostProfile,
  journal: MobileRelayDirectUpgradeJournal,
  endpoints: PairingGetEndpointsResult,
  dependencies: Dependencies
): Promise<MobileRelayDirectUpgradeResult> {
  if (endpoints.installStatus?.state !== 'committed' || !endpoints.relay) {
    throw new Error('direct pairing upgrade was not authoritatively committed')
  }
  const installed = endpoints.installStatus.result
  assertDirectInstall(journal, installed)
  const bundle = MobileRelayCredentialBundleSchema.parse({
    v: 1,
    hostId: host.id,
    deviceToken: host.deviceToken,
    current: {
      token: journal.pendingResumeToken,
      hash: journal.pendingResumeTokenHash,
      version: installed.currentVersion,
      expiresAt: installed.resumeExpiresAt
    }
  })
  // Why: the overlay must never advertise relay without its matching credential.
  await dependencies.writeBundle(bundle)
  let updatedHost: HostProfile
  try {
    updatedHost = await persistRelayHost(host, endpoints.relay, dependencies.saveHost)
  } catch (error) {
    if (error instanceof MobileRelayUpgradeHostRemovedError) {
      await dependencies.deleteBundle(host.id)
      await dependencies.clearJournal(host.id)
    }
    throw error
  }
  await dependencies.clearJournal(host.id)
  return { host: updatedHost, bundle }
}

async function getEndpoints(
  client: RpcClient,
  installReqId: string
): Promise<PairingGetEndpointsResult | 'method-not-found'> {
  const response = await client.sendRequest('pairing.getEndpoints', { installReqId })
  if (isMethodNotFound(response)) {
    return 'method-not-found'
  }
  return PairingGetEndpointsResultSchema.parse(requireSuccess(response))
}

function assertDirectInstall(
  journal: MobileRelayDirectUpgradeJournal,
  installed: DeviceCredentialInstalled
): void {
  if (installed.reqId !== journal.reqId || installed.authorizationMode !== 'authenticated-direct') {
    throw new Error('relay credential install does not match direct upgrade journal')
  }
}

function assertCommitted(
  endpoints: PairingGetEndpointsResult,
  installed: DeviceCredentialInstalled
): void {
  if (
    endpoints.installStatus?.state !== 'committed' ||
    JSON.stringify(endpoints.installStatus.result) !== JSON.stringify(installed)
  ) {
    throw new Error('relay credential install was not authoritatively reconciled')
  }
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
