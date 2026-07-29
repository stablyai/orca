import { describe, expect, it, vi } from 'vitest'
import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import { MobileRelayUpgradeHostRemovedError } from './host-store'
import {
  createMobileRelayDirectUpgradeJournal,
  type MobileRelayDirectUpgradeJournal
} from './mobile-relay-direct-upgrade-journal'
import { upgradeDirectMobileRelay } from './mobile-relay-direct-upgrade'
import type { RpcClient } from './rpc-client'
import type { HostProfile, RpcResponse } from './types'

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
    saveHost: vi.fn(async () => {}),
    randomBytes: (length: number) => new Uint8Array(length).fill(7)
  }
}

describe('existing direct pairing relay upgrade', () => {
  it('persists pending material before install and publishes only after committed status', async () => {
    const deps = dependencies()
    let journal: MobileRelayDirectUpgradeJournal | null = null
    deps.writeJournal.mockImplementation(async (next) => {
      journal = next
    })
    const client = clientWith([
      success({ v: 1, relay }),
      success({
        v: 1,
        reqId: 'upgrade-BwcHBwcHBwcHBwcHBwcHBw',
        authorizationMode: 'authenticated-direct',
        currentVersion: 1,
        resumeExpiresAt: 9_999_999
      }),
      success({
        v: 1,
        relay,
        installStatus: {
          v: 1,
          reqId: 'upgrade-BwcHBwcHBwcHBwcHBwcHBw',
          state: 'committed',
          result: {
            v: 1,
            reqId: 'upgrade-BwcHBwcHBwcHBwcHBwcHBw',
            authorizationMode: 'authenticated-direct',
            currentVersion: 1,
            resumeExpiresAt: 9_999_999
          }
        }
      })
    ])

    const result = await upgradeDirectMobileRelay({ client, host, dependencies: deps })

    expect(journal).not.toBeNull()
    expect(deps.writeJournal.mock.invocationCallOrder[0]).toBeLessThan(
      client.sendRequest.mock.invocationCallOrder[0]!
    )
    expect(client.sendRequest).toHaveBeenNthCalledWith(2, 'pairing.provisionRelay', {
      reqId: journal!.reqId,
      newResumeTokenHash: journal!.pendingResumeTokenHash
    })
    expect(deps.writeBundle).toHaveBeenCalledBefore(deps.saveHost)
    expect(result?.host.relay).toEqual(relay)
    expect(deps.clearJournal).toHaveBeenCalledWith(host.id)
  })

  it('recovers an already committed install without authorizing a second one', async () => {
    const journal = createMobileRelayDirectUpgradeJournal(host.id, (length) =>
      new Uint8Array(length).fill(3)
    )
    const committed = installed(journal)
    const deps = dependencies(journal)
    const client = clientWith([
      success({
        v: 1,
        relay,
        installStatus: { v: 1, reqId: journal.reqId, state: 'committed', result: committed }
      })
    ])

    const result = await upgradeDirectMobileRelay({ client, host, dependencies: deps })

    expect(client.sendRequest).toHaveBeenCalledOnce()
    expect(result?.bundle.current.version).toBe(1)
    expect(deps.writeBundle).toHaveBeenCalledOnce()
  })

  it('cleans pending state and leaves direct access unchanged for an old desktop', async () => {
    const deps = dependencies()
    const client = clientWith([
      {
        id: 'rpc',
        ok: false,
        error: { code: 'method_not_found', message: 'unsupported' },
        _meta: { runtimeId: 'runtime' }
      }
    ])

    await expect(upgradeDirectMobileRelay({ client, host, dependencies: deps })).resolves.toBeNull()
    expect(deps.clearJournal).toHaveBeenCalledWith(host.id)
    expect(deps.writeBundle).not.toHaveBeenCalled()
    expect(deps.saveHost).not.toHaveBeenCalled()
  })

  it('retains the durable journal when relay registration is temporarily unavailable', async () => {
    const deps = dependencies()
    const client = clientWith([success({ v: 1, relay: null })])

    await expect(upgradeDirectMobileRelay({ client, host, dependencies: deps })).rejects.toThrow(
      'relay endpoint unavailable'
    )
    expect(deps.writeJournal).toHaveBeenCalledOnce()
    expect(deps.clearJournal).not.toHaveBeenCalled()
  })

  it('cleans newly installed secrets instead of resurrecting a removed host', async () => {
    const journal = createMobileRelayDirectUpgradeJournal(host.id, (length) =>
      new Uint8Array(length).fill(5)
    )
    const committed = installed(journal)
    const deps = dependencies(journal)
    deps.saveHost.mockRejectedValue(
      new MobileRelayUpgradeHostRemovedError('mobile relay upgrade host was removed')
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
    ).rejects.toBeInstanceOf(MobileRelayUpgradeHostRemovedError)
    expect(deps.deleteBundle).toHaveBeenCalledWith(host.id)
    expect(deps.clearJournal).toHaveBeenCalledWith(host.id)
  })
})
