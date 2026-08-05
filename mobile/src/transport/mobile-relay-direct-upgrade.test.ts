import { describe, expect, it, vi } from 'vitest'
import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import {
  MobileRelayUpgradeLifecycleRetiredError,
  MobileRelayUpgradeHostRemovedError,
  MobileRelayUpgradeHostSupersededError
} from './existing-host-relay-routing'
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
    clearJournal: vi.fn(async (expected: MobileRelayDirectUpgradeJournal) => {
      if (stored?.reqId !== expected.reqId) {
        return false
      }
      stored = null
      return true
    }),
    writeBundle: vi.fn(async () => {}),
    saveHost: vi.fn(async (_host: HostProfile, beforePublish?: () => Promise<void>) => {
      await beforePublish?.()
    }),
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
    expect(deps.saveHost).toHaveBeenCalledWith(expect.any(Object), expect.any(Function))
    expect(deps.writeBundle).toHaveBeenCalledOnce()
    expect(result?.host.relay).toEqual(relay)
    expect(deps.clearJournal).toHaveBeenCalledWith(journal)
  })

  it('does not delete a replacement pairing bundle when the old upgrade is superseded', async () => {
    const journal = createMobileRelayDirectUpgradeJournal(host.id, (length) =>
      new Uint8Array(length).fill(6)
    )
    const committed = installed(journal)
    const deps = dependencies(journal)
    deps.saveHost.mockRejectedValue(
      new MobileRelayUpgradeHostSupersededError('mobile relay upgrade host was re-paired')
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
    ).rejects.toBeInstanceOf(MobileRelayUpgradeHostSupersededError)
    expect(deps.writeBundle).not.toHaveBeenCalled()
    expect(deps.clearJournal).toHaveBeenCalledWith(journal)
  })

  it('does not clear a replacement lifecycle journal from a superseded upgrade', async () => {
    const journal = createMobileRelayDirectUpgradeJournal(host.id, (length) =>
      new Uint8Array(length).fill(6)
    )
    const replacement = createMobileRelayDirectUpgradeJournal(host.id, (length) =>
      new Uint8Array(length).fill(9)
    )
    const committed = installed(journal)
    const deps = dependencies(journal)
    deps.saveHost.mockImplementation(async () => {
      await deps.writeJournal(replacement)
      throw new MobileRelayUpgradeHostSupersededError('mobile relay upgrade host was re-paired')
    })
    const client = clientWith([
      success({
        v: 1,
        relay,
        installStatus: { v: 1, reqId: journal.reqId, state: 'committed', result: committed }
      })
    ])

    await expect(
      upgradeDirectMobileRelay({ client, host, dependencies: deps })
    ).rejects.toBeInstanceOf(MobileRelayUpgradeHostSupersededError)

    await expect(deps.readJournal()).resolves.toEqual(replacement)
  })

  it('retains a committed journal when an endpoint lifecycle is retired', async () => {
    const journal = createMobileRelayDirectUpgradeJournal(host.id, (length) =>
      new Uint8Array(length).fill(6)
    )
    const committed = installed(journal)
    const deps = dependencies(journal)
    deps.saveHost.mockRejectedValue(
      new MobileRelayUpgradeLifecycleRetiredError('mobile relay endpoint lifecycle was retired')
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
    ).rejects.toBeInstanceOf(MobileRelayUpgradeLifecycleRetiredError)
    expect(deps.clearJournal).not.toHaveBeenCalled()
    await expect(deps.readJournal()).resolves.toEqual(journal)
  })

  it('retains recovery state when host identity credentials are temporarily unavailable', async () => {
    const journal = createMobileRelayDirectUpgradeJournal(host.id, (length) =>
      new Uint8Array(length).fill(8)
    )
    const committed = installed(journal)
    const deps = dependencies(journal)
    deps.saveHost.mockRejectedValue(new Error('keychain locked'))
    const client = clientWith([
      success({
        v: 1,
        relay,
        installStatus: { v: 1, reqId: journal.reqId, state: 'committed', result: committed }
      })
    ])

    await expect(upgradeDirectMobileRelay({ client, host, dependencies: deps })).rejects.toThrow(
      'keychain locked'
    )
    expect(deps.writeBundle).not.toHaveBeenCalled()
    expect(deps.clearJournal).not.toHaveBeenCalled()
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
    expect(deps.clearJournal).toHaveBeenCalledWith(expect.objectContaining({ hostId: host.id }))
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

  it('does not delete a replacement bundle when removal wins before credential publication', async () => {
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
    expect(deps.writeBundle).not.toHaveBeenCalled()
    expect(deps.clearJournal).toHaveBeenCalledWith(journal)
  })
})
