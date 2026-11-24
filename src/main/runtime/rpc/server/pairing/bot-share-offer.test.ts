import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { describe, expect, it, vi } from 'vitest'
import type { RelayDeviceBinding } from '../../../mobile-cloud-relay/pairing/relay-revoke-outbox'
import { BotShareDeviceStore } from './bot-share-device-store'
import { mintBotShareOffer } from './bot-share-offer'

const RELAY_HOST = 'AbCdEf0123_-xyZ9'

function setup() {
  const store = new BotShareDeviceStore(
    mkdtempSync(join(tmpdir(), 'orca-share-offer-')),
    () => false
  )
  let invites = 0
  const createPairingRelay = vi.fn(async (relayDeviceId: string) => {
    invites += 1
    const inviteExpiresAt = 1_000_000 + invites
    return {
      relay: {
        v: 1 as const,
        directorUrl: 'https://director.example',
        cellUrl: 'https://cell.example',
        assignmentEpoch: 1,
        relayHostId: RELAY_HOST,
        inviteToken: `invite-${invites}`.padEnd(43, 'x'),
        inviteExpiresAt,
        e2eeFraming: 2 as const
      },
      binding: {
        relayHostId: RELAY_HOST,
        relayDeviceId,
        ownerIdentityKey: 'owner',
        inviteExpiresAt
      }
    }
  })
  const deps = {
    store,
    relay: { createPairingRelay },
    hostPublicKeyB64: Buffer.from(nacl.box.keyPair().publicKey).toString('base64'),
    bindRelay: (deviceId: string, binding: RelayDeviceBinding) =>
      store.setRelayBinding(deviceId, binding),
    revokeRelay: vi.fn()
  }
  return { store, deps, createPairingRelay }
}

const alice = { botId: 'bot-1', accountId: 'acct-alice', name: 'Alice' }
const key = () => Buffer.from(nacl.sign.keyPair().publicKey).toString('base64')

describe('minting a share offer', () => {
  it('keeps one row per device key on a bot, with a fresh invite on every ask', async () => {
    const { store, deps } = setup()
    const devicePublicKey = key()
    const first = await mintBotShareOffer(deps, { ...alice, devicePublicKey })
    const again = await mintBotShareOffer(deps, { ...alice, devicePublicKey })
    expect(again.deviceId).toBe(first.deviceId)
    expect(again.relay.inviteToken).not.toBe(first.relay.inviteToken)
    const otherBot = await mintBotShareOffer(deps, { ...alice, botId: 'bot-2', devicePublicKey })
    expect(otherBot.deviceId).not.toBe(first.deviceId)
    expect(store.list().map((row) => [row.botId, row.accountId])).toEqual([
      ['bot-1', 'acct-alice'],
      ['bot-2', 'acct-alice']
    ])
  })

  it('leaves a device that holds its resume credential on it', async () => {
    const { store, deps } = setup()
    const devicePublicKey = key()
    const { deviceId } = await mintBotShareOffer(deps, { ...alice, devicePublicKey })
    const resumed = { relayHostId: RELAY_HOST, relayDeviceId: deviceId, ownerIdentityKey: 'owner' }
    await store.setRelayBinding(deviceId, resumed)
    await mintBotShareOffer(deps, { ...alice, devicePublicKey })
    expect(store.get(deviceId)?.relayBinding).toEqual(resumed)
  })

  it('makes one row for concurrent asks with the same key', async () => {
    const { store, deps } = setup()
    const devicePublicKey = key()
    const [a, b] = await Promise.all([
      mintBotShareOffer(deps, { ...alice, devicePublicKey }),
      mintBotShareOffer(deps, { ...alice, devicePublicKey })
    ])
    expect(a.deviceId).toBe(b.deviceId)
    expect(store.list()).toHaveLength(1)
  })
})
