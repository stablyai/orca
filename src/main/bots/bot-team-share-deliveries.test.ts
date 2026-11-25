import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { withBotShareAnswer, type BotShare } from '../../shared/bots/bot-team-shares'
import {
  openBotTeamShareOffer,
  type BotTeamShareOffer
} from '../../shared/bots/bot-team-share-seal'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../shared/remote-runtime/e2ee/node/paired-e2ee-node-primitives'
import {
  acceptBotShare,
  resolveBotShareInvite,
  type BotShareAcceptDeps
} from './bot-team-share-deliveries'
import { botSharedWithAccount } from './team-share/bot-share-access'
import { BotShareDeviceStore } from '../runtime/rpc/server/pairing/bot-share-device-store'
import { connectorBots } from '../connector-cloud/connector-places'
import { makeTestBot } from './bot.test-fixture'

const primitives = NODE_PAIRED_E2EE_PRIMITIVES
const device = primitives.generateKeyPair()
const sealKeys = primitives.generateKeyPair()
const key = (bytes: Uint8Array) => primitives.publicKeyToBase64(bytes)

const shares: BotShare[] = [
  {
    kind: 'account',
    shareId: 'share-alice',
    accountId: 'acct-alice',
    name: 'Alice',
    email: 'alice@example.com',
    addedAt: 1
  },
  { kind: 'invite', shareId: 'share-bob', email: 'bob@example.com', addedAt: 1 }
]

const offer: BotTeamShareOffer = {
  v: 1,
  relay: {
    v: 1,
    directorUrl: 'https://director.example.com',
    cellUrl: 'https://cell.example.com',
    assignmentEpoch: 1,
    relayHostId: 'AAAAAAAAAAAAAAAA',
    inviteToken: 'A'.repeat(43),
    e2eeFraming: 2,
    inviteExpiresAt: 2
  },
  hostPublicKeyB64: key(primitives.generateKeyPair().publicKey),
  deviceId: 'share-device-1',
  botId: 'bot-1'
}

function accept(shareId: string, accountId: string) {
  return {
    kind: 'share_accept' as const,
    deliveryId: 'd1',
    expiresAt: 10,
    conversation: { source: 'orca' as const, externalId: shareId },
    shareId,
    botId: 'bot-1',
    accountId,
    devicePublicKey: key(device.publicKey),
    sealKey: key(sealKeys.publicKey)
  }
}

function deps(sent: { ok: true } | { ok: false; error: string }) {
  const putOffer = vi.fn<BotShareAcceptDeps['putOffer']>(async () => sent)
  const mintOffer = vi.fn<BotShareAcceptDeps['mintOffer']>(async () => offer)
  const value: BotShareAcceptDeps = {
    bots: { list: () => [{ id: 'bot-1', shares }] },
    mintOffer,
    revokeDevices: vi.fn(async () => true),
    putOffer
  }
  return { value, putOffer, mintOffer }
}

describe('share accept on the host', () => {
  it('answers only the account the share names, with the offer sealed to its seal key', async () => {
    const { value, putOffer, mintOffer } = deps({ ok: true })
    await expect(acceptBotShare(value, accept('share-alice', 'acct-eve'))).resolves.toBe(false)
    await expect(acceptBotShare(value, accept('share-bob', 'acct-bob'))).resolves.toBe(false)
    expect(mintOffer).not.toHaveBeenCalled()

    await expect(acceptBotShare(value, accept('share-alice', 'acct-alice'))).resolves.toBe(true)
    expect(mintOffer).toHaveBeenCalledWith({
      botId: 'bot-1',
      accountId: 'acct-alice',
      name: 'Alice',
      devicePublicKey: key(device.publicKey)
    })
    const [botId, shareId, body] = putOffer.mock.calls[0]!
    expect([botId, shareId, body.devicePublicKey]).toEqual([
      'bot-1',
      'share-alice',
      key(device.publicKey)
    ])
    const open = (secretKey: Uint8Array) =>
      openBotTeamShareOffer(primitives, {
        sealSecretKey: secretKey,
        sealed: body.sealedOffer,
        expect: { botId: 'bot-1' }
      })
    expect(open(sealKeys.secretKey)).toEqual(offer)
    expect(open(device.secretKey)).toBeNull()
  })

  it('ends the device it minted when the share was removed meanwhile, even if that revoke fails', async () => {
    let listed = shares
    const bots = { list: () => [{ id: 'bot-1', shares: listed }] }
    const store = new BotShareDeviceStore(
      mkdtempSync(join(tmpdir(), 'orca-share-race-')),
      (grant) => botSharedWithAccount(bots.list(), grant)
    )
    let deviceId = ''
    const { value, putOffer } = deps({ ok: true })
    const revokeDevices = vi.fn<BotShareAcceptDeps['revokeDevices']>(async () => false)
    const accepted = acceptBotShare(
      {
        ...value,
        bots,
        revokeDevices,
        mintOffer: async (ask) => {
          // The owner removes Alice after the accept was checked, before its row is written.
          listed = []
          deviceId = (
            await store.add({ ...ask, scope: 'runtime', devicePublicKeyB64: ask.devicePublicKey })
          ).deviceId
          return offer
        }
      },
      accept('share-alice', 'acct-alice')
    )
    await expect(accepted).resolves.toBe(false)
    expect(revokeDevices).toHaveBeenCalledExactlyOnceWith('bot-1', 'acct-alice')
    expect(putOffer).not.toHaveBeenCalled()
    // The revoke failed and the row is left, yet it signs in as nothing.
    expect(store.get(deviceId)).not.toBeNull()
    expect(store.lookupDeviceKey(deviceId)).toEqual({ kind: 'refused' })
  })

  it('fails the accept when the cloud does not take the offer', async () => {
    const { value } = deps({ ok: false, error: 'unknown_share' })
    await expect(acceptBotShare(value, accept('share-alice', 'acct-alice'))).rejects.toThrow(
      'unknown_share'
    )
  })
})

describe('a share its teammate declined', () => {
  const declined: BotShare[] = [
    {
      kind: 'account',
      shareId: 'share-alice',
      accountId: 'acct-alice',
      name: 'Alice',
      email: 'alice@example.com',
      addedAt: 1,
      declinedAt: 5
    },
    shares[1]!
  ]

  it('grants nothing: no offer, no device signs in, no later answer, and the hello omits it', async () => {
    const { value, mintOffer, putOffer } = deps({ ok: true })
    const bots = { list: () => [{ id: 'bot-1', shares: declined }] }
    await expect(
      acceptBotShare({ ...value, bots }, accept('share-alice', 'acct-alice'))
    ).resolves.toBe(false)
    expect(mintOffer).not.toHaveBeenCalled()
    expect(putOffer).not.toHaveBeenCalled()

    expect(botSharedWithAccount(bots.list(), { botId: 'bot-1', accountId: 'acct-alice' })).toBe(
      false
    )
    const answer = { shareId: 'share-alice', accountId: 'acct-alice', answer: 'accepted' as const }
    expect(withBotShareAnswer(declined, answer, 9)).toBe(declined)

    const hello = connectorBots({
      getBots: () => [makeTestBot({ id: 'bot-1', shares: declined })]
    })
    expect(hello[0]?.sharedWith).toEqual([{ shareId: 'share-bob', email: 'bob@example.com' }])
  })
})

describe('invite resolved on the host', () => {
  const invite: BotShare = {
    kind: 'invite',
    shareId: 'share-carol',
    email: 'carol@example.com',
    addedAt: 1
  }
  const resolved = {
    kind: 'share_resolved' as const,
    deliveryId: 'd2',
    expiresAt: 10,
    conversation: { source: 'orca' as const, externalId: 'share-carol' },
    shareId: 'share-carol',
    botId: 'bot-1',
    email: 'carol@example.com',
    accountId: 'acct-carol'
  }
  function hostWith(listed: BotShare[], saved: BotShare[]) {
    const writes: (BotShare[] | undefined)[] = []
    const bots = {
      list: () => [{ id: 'bot-1', shares: listed }],
      update: async (
        _botId: string,
        edit: (bot: { shares?: BotShare[] }) => { shares?: BotShare[] }
      ) => {
        writes.push(edit({ shares: saved }).shares)
      }
    }
    return { bots, writes }
  }

  it('writes the account under the invite id when the invite is still there', async () => {
    const { bots, writes } = hostWith([invite], [invite])
    await expect(resolveBotShareInvite(bots, resolved)).resolves.toBe(true)
    expect(writes).toEqual([
      [
        {
          kind: 'account',
          shareId: 'share-carol',
          accountId: 'acct-carol',
          email: 'carol@example.com',
          addedAt: 1
        }
      ]
    ])
  })

  it('is refused, writing nothing, when the invite was removed before or during the write', async () => {
    const removedBefore = hostWith([], [])
    await expect(resolveBotShareInvite(removedBefore.bots, resolved)).resolves.toBe(false)
    expect(removedBefore.writes).toEqual([])
    const removedDuring = hostWith([invite], [])
    await expect(resolveBotShareInvite(removedDuring.bots, resolved)).resolves.toBe(false)
    expect(removedDuring.writes).toEqual([undefined])
  })
})
