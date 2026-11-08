import { describe, expect, it, vi } from 'vitest'
import type { MobileRelayEndpoint } from '../../../../src/shared/remote-runtime/relay/mobile-relay-credential-contract'
import { RelayRoutingHostRemovedError } from '../host-store'
import {
  createMobileRelayDirectUpgradeJournal,
  type MobileRelayDirectUpgradeJournal
} from './mobile-relay-direct-upgrade-journal'
import { upgradeDirectMobileRelay } from './mobile-relay-direct-upgrade'
import type { RpcClient } from '../rpc-client'
import type { HostProfile, RpcResponse } from '../types'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

const relay: MobileRelayEndpoint = {
  v: 1,
  directorUrl: 'https://relay-staging.onorca.dev',
  cellUrl: 'https://c1.relay-staging.onorca.dev',
  assignmentEpoch: 4,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2
}

const host: HostProfile = {
  id: 'host-direct',
  name: 'Host 4',
  endpoint: 'ws://192.168.1.2:6768',
  deviceToken: 'device-token',
  publicKeyB64: 'A'.repeat(44),
  lastConnected: 1
}

function success(result: unknown): RpcResponse {
  return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'runtime' } }
}

function clientWith(responses: RpcResponse[]) {
  return {
    sendRequest: vi.fn(async () => responses.shift()!),
    getState: () => 'connected'
  } as unknown as RpcClient
}

function installed(journal: MobileRelayDirectUpgradeJournal) {
  return {
    v: 1 as const,
    reqId: journal.reqId,
    authorizationMode: 'authenticated-direct' as const,
    currentVersion: 1,
    resumeExpiresAt: 9_999_999
  }
}

function dependencies(journal: MobileRelayDirectUpgradeJournal | null = null) {
  let stored = journal
  return {
    readJournal: vi.fn(async () => stored),
    writeJournal: vi.fn(async (next: MobileRelayDirectUpgradeJournal) => {
      stored = next
    }),
    clearJournal: vi.fn(async () => {
      stored = null
    }),
    writeBundle: vi.fn(async () => {}),
    deleteBundle: vi.fn(async () => {}),
    setRelayRouting: vi.fn(async () => {}),
    randomBytes: (length: number) => new Uint8Array(length).fill(7)
  }
}

describe('existing direct pairing relay upgrade', () => {
  it('cleans newly installed secrets instead of resurrecting a removed host', async () => {
    const journal = createMobileRelayDirectUpgradeJournal(host.id, (length) =>
      new Uint8Array(length).fill(5)
    )
    const committed = installed(journal)
    const deps = dependencies(journal)
    deps.setRelayRouting.mockRejectedValue(
      new RelayRoutingHostRemovedError('mobile relay upgrade host was removed')
    )
    const client = clientWith([
      success({
        v: 1,
        relay,
        installStatus: { v: 1, reqId: journal.reqId, state: 'committed', result: committed }
      })
    ])

    await expect(
      upgradeDirectMobileRelay({ client, host, dependencies: deps })
    ).rejects.toBeInstanceOf(RelayRoutingHostRemovedError)
    expect(deps.deleteBundle).toHaveBeenCalledWith(host.id)
    expect(deps.clearJournal).toHaveBeenCalledWith(host.id)
  })
})
