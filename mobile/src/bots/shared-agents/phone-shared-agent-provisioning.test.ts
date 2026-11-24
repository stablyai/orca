// A phone's key to a shared agent: only the host key the computer pinned is taken, a kept key asks
// again as itself, and the device secret and share credential never leave the keychain.
import nacl from 'tweetnacl'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const appStorage = new Map<string, string>()
const keychain = new Map<string, string>()
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => appStorage.get(key) ?? null,
    setItem: async (key: string, value: string) => void appStorage.set(key, value)
  }
}))
vi.mock('../../host-credentials/pairing-keychain', () => ({
  readPairingKeychainItem: async (key: string) => keychain.get(key) ?? null,
  writePairingKeychainItem: async (key: string, value: string) => void keychain.set(key, value),
  deletePairingKeychainItem: async (key: string) => void keychain.delete(key)
}))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

import { SharedBotsPhoneProvisionParams } from '../../../../src/shared/bots/bot-share-phone'
import { sealBotTeamShareOffer } from '../../../../src/shared/bots/bot-team-share-seal'
import { hashRelayCredential } from '../../../../src/shared/remote-runtime/relay/relay-credential-hash'
import type { RpcResponse } from '../../../../src/shared/remote-runtime/rpc/rpc-response-shape'
import { MOBILE_PAIRED_E2EE_PRIMITIVES as PRIMITIVES } from '../../transport/encryption/mobile-paired-e2ee-primitives'
import { syncComputerShares } from './phone-shared-agent-provisioning'
import { PhoneSharedAgentStore } from './phone-shared-agent-store'

const b64 = (bytes: Uint8Array) => PRIMITIVES.encodeBase64(bytes)
const PINNED = b64(nacl.box.keyPair().publicKey)
const share = {
  shareId: 'share-1',
  botId: 'bot-1',
  botName: 'Ivy',
  ownerName: 'Jinwoo Hong',
  environmentId: 'env-1'
}

type Ask = SharedBotsPhoneProvisionParams

/** The computer, answering as the host would: the offer sealed to the phone, under `hostKey`. */
function computer(hostKey = PINNED) {
  const asks: Ask[] = []
  const client = {
    sendRequest: async (_method: string, params?: unknown): Promise<RpcResponse> => {
      const ask = SharedBotsPhoneProvisionParams.parse(params)
      asks.push(ask)
      const offer = {
        v: 1 as const,
        relay: {
          v: 1 as const,
          directorUrl: 'https://director.example',
          cellUrl: 'https://cell.example',
          assignmentEpoch: 1,
          relayHostId: 'AbCdEf0123_-xyZ9',
          inviteToken: 'i'.repeat(43),
          e2eeFraming: 2 as const,
          inviteExpiresAt: 10
        },
        hostPublicKeyB64: hostKey,
        deviceId: 'phone-key-1',
        botId: 'bot-1'
      }
      const result = {
        v: 1,
        ...share,
        connectorOrigin: 'https://cloud.example',
        hostKey: PINNED,
        sealedOffer: sealBotTeamShareOffer(PRIMITIVES, { sealKey: ask.sealKey, offer })
      }
      return { id: 'x', ok: true, result }
    }
  }
  return { asks, computer: { pairedHostId: 'computer-1', client } }
}

beforeEach(() => {
  appStorage.clear()
  keychain.clear()
})

describe('a phone’s key to a shared agent', () => {
  it('keeps the offer only under the pinned host key, its secrets only in the keychain', async () => {
    const store = new PhoneSharedAgentStore()
    await store.load()
    await syncComputerShares(
      store,
      computer(b64(nacl.box.keyPair().publicKey)).computer,
      [share],
      () => true
    )
    expect(store.list()).toEqual([])

    const { asks, computer: pinned } = computer()
    await syncComputerShares(store, pinned, [share], () => true)
    const [entry] = store.list()
    expect(entry?.offer.deviceId).toBe('phone-key-1')
    expect(asks[0]?.credentialHash).toBe(hashRelayCredential(entry!.credential))
    await store.flushed()
    const index = [...appStorage.values()].join('')
    expect(index).not.toContain(entry!.deviceKey.secretKeyB64)
    expect(index).not.toContain(entry!.credential)

    const reread = new PhoneSharedAgentStore()
    await reread.load()
    expect(reread.list()).toEqual([entry])
  })

  it('asks again with the key and credential it keeps, and forgets a share the computer dropped', async () => {
    const store = new PhoneSharedAgentStore()
    await store.load()
    const { asks, computer: pinned } = computer()
    await syncComputerShares(store, pinned, [share], () => true)
    await syncComputerShares(store, pinned, [share], () => true)
    expect(asks[1]?.devicePublicKey).toBe(asks[0]?.devicePublicKey)
    expect(asks[1]?.credentialHash).toBe(asks[0]?.credentialHash)

    await syncComputerShares(store, pinned, [], () => true)
    expect(store.list()).toEqual([])
    await store.flushed()
    expect(keychain.size).toBe(0)
  })
})
