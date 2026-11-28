import nacl from 'tweetnacl'
import { describe, expect, it } from 'vitest'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../src/shared/remote-runtime/e2ee/node/paired-e2ee-node-primitives'
import { encodeDeviceProofMessage } from '../../../src/shared/remote-runtime/pairing/device-key-proof'
import {
  openBotTeamShareHeldMessage,
  openBotTeamShareOffer,
  sealBotTeamShareHeldMessage,
  sealBotTeamShareOffer,
  type BotTeamShareHeldMessage,
  type BotTeamShareOffer
} from '../../../src/shared/bots/bot-team-share-seal'
import { MOBILE_PAIRED_E2EE_PRIMITIVES } from '../transport/encryption/mobile-paired-e2ee-primitives'

const host = nacl.box.keyPair()
const device = nacl.sign.keyPair()
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const sign = async (message: Uint8Array) => nacl.sign.detached(message, device.secretKey)

const message: BotTeamShareHeldMessage = {
  v: 1,
  shareId: 'share-1',
  botId: 'bot-1',
  chat: { newChatId: 'chat-new-1' },
  clientMessageId: 'msg-1',
  text: 'Can you check the build? ✓',
  attachments: [{ name: 'log.txt', contentBase64: b64(new TextEncoder().encode('fail')) }],
  sentAt: 1_764_000_000_000,
  devicePublicKey: b64(device.publicKey)
}
const expect1 = { shareId: 'share-1', botId: 'bot-1', clientMessageId: 'msg-1' }
const open = (
  sealed: string,
  overrides: Partial<Parameters<typeof openBotTeamShareHeldMessage>[1]> = {}
) =>
  openBotTeamShareHeldMessage(NODE_PAIRED_E2EE_PRIMITIVES, {
    hostSecretKey: host.secretKey,
    hostKey: b64(host.publicKey),
    sealed,
    expect: expect1,
    ...overrides
  })

describe('held message seal', () => {
  // The phone (Hermes primitives) and the desktop seal alike, and the host (Node) opens both.
  it.each([
    ['phone', MOBILE_PAIRED_E2EE_PRIMITIVES],
    ['desktop', NODE_PAIRED_E2EE_PRIMITIVES]
  ])('round-trips from the %s to the host', async (_name, primitives) => {
    const sealed = await sealBotTeamShareHeldMessage(primitives, {
      hostKey: b64(host.publicKey),
      message,
      sign
    })
    expect(open(sealed)).toEqual(message)
  })

  it('opens only for the host key, the delivery it came in, and a share-send signature', async () => {
    const sealed = await sealBotTeamShareHeldMessage(MOBILE_PAIRED_E2EE_PRIMITIVES, {
      hostKey: b64(host.publicKey),
      message,
      sign
    })
    expect(open(sealed, { hostSecretKey: nacl.box.keyPair().secretKey })).toBeNull()
    expect(open(sealed, { expect: { ...expect1, shareId: 'share-2' } })).toBeNull()
    expect(open(sealed, { expect: { ...expect1, clientMessageId: 'msg-2' } })).toBeNull()

    const tampered = Buffer.from(sealed, 'base64')
    tampered[tampered.length - 1] ^= 1
    expect(open(tampered.toString('base64'))).toBeNull()

    // Another key's signature, or a relay auth proof over the same bytes, never passes as the device's.
    const stranger = nacl.sign.keyPair()
    const forged = await sealBotTeamShareHeldMessage(MOBILE_PAIRED_E2EE_PRIMITIVES, {
      hostKey: b64(host.publicKey),
      message,
      sign: async (bytes) => nacl.sign.detached(bytes, stranger.secretKey)
    })
    expect(open(forged)).toBeNull()
    const asAuth = await sealBotTeamShareHeldMessage(MOBILE_PAIRED_E2EE_PRIMITIVES, {
      hostKey: b64(host.publicKey),
      message,
      sign: async (bytes) => {
        const hash = bytes.subarray(-32)
        return nacl.sign.detached(encodeDeviceProofMessage('auth', hash), device.secretKey)
      }
    })
    expect(open(asAuth)).toBeNull()
  })

  it('refuses a message one host opened and re-sealed to another', async () => {
    const sealed = await sealBotTeamShareHeldMessage(MOBILE_PAIRED_E2EE_PRIMITIVES, {
      hostKey: b64(host.publicKey),
      message,
      sign
    })
    const bytes = Buffer.from(sealed, 'base64')
    const plaintext = nacl.box.open(
      bytes.subarray(56),
      bytes.subarray(32, 56),
      bytes.subarray(0, 32),
      host.secretKey
    )
    const resealTo = (recipient: Uint8Array) => {
      const ephemeral = nacl.box.keyPair()
      const nonce = nacl.randomBytes(24)
      return Buffer.concat([
        ephemeral.publicKey,
        nonce,
        nacl.box(plaintext!, nonce, recipient, ephemeral.secretKey)
      ]).toString('base64')
    }
    expect(open(resealTo(host.publicKey))).toEqual(message)
    const other = nacl.box.keyPair()
    expect(
      open(resealTo(other.publicKey), {
        hostSecretKey: other.secretKey,
        hostKey: b64(other.publicKey)
      })
    ).toBeNull()
  })
})

describe('share offer seal', () => {
  const sealKeys = nacl.box.keyPair()
  const offer: BotTeamShareOffer = {
    v: 1,
    relay: {
      v: 1,
      directorUrl: 'https://relay.orca.dev',
      cellUrl: 'https://cell-1.relay.orca.dev',
      assignmentEpoch: 3,
      relayHostId: 'AbCdEf0123_-xyZ9',
      inviteToken: 'A'.repeat(43),
      inviteExpiresAt: 1_764_000_600_000,
      e2eeFraming: 2
    },
    hostPublicKeyB64: b64(host.publicKey),
    deviceId: 'share-device-1',
    botId: 'bot-1'
  }
  // The host (Node) seals; the teammate's desktop and phone both open it.
  it.each([
    ['phone', MOBILE_PAIRED_E2EE_PRIMITIVES],
    ['desktop', NODE_PAIRED_E2EE_PRIMITIVES]
  ])('opens on the %s, only with its seal key and for the bot asked for', (_name, primitives) => {
    const sealed = sealBotTeamShareOffer(NODE_PAIRED_E2EE_PRIMITIVES, {
      sealKey: b64(sealKeys.publicKey),
      offer
    })
    const openOffer = (secretKey: Uint8Array, botId = 'bot-1') =>
      openBotTeamShareOffer(primitives, { sealSecretKey: secretKey, sealed, expect: { botId } })
    expect(openOffer(sealKeys.secretKey)).toEqual(offer)
    expect(openOffer(nacl.box.keyPair().secretKey)).toBeNull()
    expect(openOffer(sealKeys.secretKey, 'bot-2')).toBeNull()
  })
})
