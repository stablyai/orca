import { describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import { deriveSharedKey } from '../../../shared/e2ee-crypto'
import { deriveMobileE2EEV2KeySchedule } from '../../../shared/mobile-e2ee-v2-node-key-schedule'
import {
  encodeMobileE2EEV2Transcript,
  validateMobileE2EEV2Handshake,
  type MobileE2EEV2Hello
} from '../../../shared/mobile-e2ee-v2-contract'
import { sealMobileE2EEV2Frame } from '../../../shared/mobile-e2ee-v2-framing'
import { PairedE2EEV2ClientSession } from '../../../shared/paired-e2ee-v2-client-session'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../shared/paired-e2ee-node-primitives'
import { RUNTIME_ORDINARY_MESSAGE_MAX_BYTES as M } from '../../../shared/runtime-ordinary-message-capability'
import {
  DesktopMobileE2EEV2Session,
  MAX_MOBILE_E2EE_V2_TEXT_FRAME_BASE64_CHARACTERS
} from './mobile-e2ee-v2-desktop-session'

const server = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(1))
const client = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(2))

function hello(): MobileE2EEV2Hello {
  return {
    type: 'e2ee_hello',
    v: 2,
    clientPublicKeyB64: Buffer.from(client.publicKey).toString('base64'),
    clientNonceB64: Buffer.from(new Uint8Array(32).fill(3)).toString('base64'),
    capabilities: { framing: [2], payloadKinds: ['text', 'binary'] },
    context: {
      protocol: 'orca-mobile-e2ee',
      initiator: 'mobile',
      responder: 'desktop',
      transport: 'relay',
      relayHostId: 'AbCdEf0123_-xyZ9'
    }
  }
}

describe('desktop mobile E2EE v2 session', () => {
  it('rejects oversized text frames before base64 decoding', () => {
    const session = DesktopMobileE2EEV2Session.create({
      hello: hello(),
      serverSecretKey: server.secretKey,
      expectedContext: { transport: 'relay', relayHostId: 'AbCdEf0123_-xyZ9' },
      randomBytes: () => new Uint8Array(32).fill(4)
    })!
    const decode = vi.spyOn(Buffer, 'from')

    expect(
      session.openText('A'.repeat(MAX_MOBILE_E2EE_V2_TEXT_FRAME_BASE64_CHARACTERS + 1))
    ).toBeNull()
    expect(decode).not.toHaveBeenCalled()
    decode.mockRestore()
  })

  function establishedPair() {
    const phone = PairedE2EEV2ClientSession.create({
      primitives: NODE_PAIRED_E2EE_PRIMITIVES,
      desktopPublicKeyB64: Buffer.from(server.publicKey).toString('base64'),
      transport: 'relay',
      relayHostId: 'AbCdEf0123_-xyZ9',
      clientKeyPair: client,
      clientNonce: new Uint8Array(32).fill(3)
    })
    const desktop = DesktopMobileE2EEV2Session.create({
      hello: phone.hello,
      serverSecretKey: server.secretKey,
      expectedContext: { transport: 'relay', relayHostId: 'AbCdEf0123_-xyZ9' },
      randomBytes: () => new Uint8Array(32).fill(4)
    })!
    expect(phone.acceptReady(desktop.ready)).toBe(true)
    return { phone, desktop }
  }

  // The admitted ordinary maximum must cross the installed decoder whole, in both directions.
  it('opens a complete maximum ordinary message and then the next small one', () => {
    const { phone, desktop } = establishedPair()
    const prefix = '{"id":"max","params":{"text":"'
    const message = `${prefix}${'x'.repeat(M - prefix.length - 7)}tail"}}`
    expect(Buffer.byteLength(message)).toBe(M)
    const frame = phone.sealText(message)
    expect(frame.length).toBe(MAX_MOBILE_E2EE_V2_TEXT_FRAME_BASE64_CHARACTERS)
    expect(desktop.openText(frame)).toBe(message)
    expect(phone.openText(desktop.sealText(message))).toBe(message)
    expect(desktop.openText(phone.sealText('{"id":"next"}'))).toBe('{"id":"next"}')
    expect(phone.openText(desktop.sealText('{"id":"next"}'))).toBe('{"id":"next"}')
  })

  it('refuses noncanonical spellings of an authentic frame without spending its counter', () => {
    const { phone, desktop } = establishedPair()
    const frame = phone.sealText('{"id":"pad"}')
    expect(frame.endsWith('=')).toBe(true)
    expect(frame).toMatch(/[+/]/)
    // The last data character's low bit is unused, so this alias decodes to the same authentic bytes.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const last = frame.replace(/=+$/, '').length - 1
    const flipped = `${frame.slice(0, last)}${alphabet[alphabet.indexOf(frame[last]!) ^ 1]}${frame.slice(last + 1)}`
    expect(Buffer.from(flipped, 'base64')).toEqual(Buffer.from(frame, 'base64'))
    for (const alias of [
      frame.replace(/=+$/, ''),
      `${frame.slice(0, 8)}\n${frame.slice(8)}`,
      frame.replaceAll('+', '-').replaceAll('/', '_'),
      `${frame}=`,
      flipped
    ]) {
      expect(desktop.openText(alias)).toBeNull()
    }
    expect(desktop.openText(frame)).toBe('{"id":"pad"}')
  })

  it('creates a fresh ready message and opens exact-next auth counter zero', () => {
    const clientHello = hello()
    const session = DesktopMobileE2EEV2Session.create({
      hello: clientHello,
      serverSecretKey: server.secretKey,
      expectedContext: { transport: 'relay', relayHostId: 'AbCdEf0123_-xyZ9' },
      randomBytes: () => new Uint8Array(32).fill(4)
    })!
    const handshake = validateMobileE2EEV2Handshake(clientHello, session.ready)!
    const schedule = deriveMobileE2EEV2KeySchedule({
      sharedSecret: deriveSharedKey(client.secretKey, server.publicKey),
      transcript: encodeMobileE2EEV2Transcript(handshake),
      clientNonce: handshake.clientNonce,
      desktopNonce: handshake.desktopNonce
    })
    const auth = JSON.stringify({
      type: 'e2ee_auth',
      v: 2,
      transcriptHashB64: session.transcriptHashB64,
      deviceToken: 'token'
    })
    const frame = sealMobileE2EEV2Frame({
      payload: new TextEncoder().encode(auth),
      key: schedule.mobileToDesktopKey,
      sessionId: schedule.sessionId,
      direction: 'mobile-to-desktop',
      payloadKind: 'text',
      counter: 0n
    })

    expect(session.openText(Buffer.from(frame).toString('base64'))).toBe(auth)
    expect(session.openText(Buffer.from(frame).toString('base64'))).toBeNull()
  })

  it('rejects a transport or relayHostId mismatch before deriving keys', () => {
    expect(
      DesktopMobileE2EEV2Session.create({
        hello: hello(),
        serverSecretKey: server.secretKey,
        expectedContext: { transport: 'direct' }
      })
    ).toBeNull()
  })

  it('shares one outbound counter across text and binary', () => {
    const session = DesktopMobileE2EEV2Session.create({
      hello: hello(),
      serverSecretKey: server.secretKey,
      expectedContext: { transport: 'relay', relayHostId: 'AbCdEf0123_-xyZ9' },
      randomBytes: () => new Uint8Array(32).fill(4)
    })!

    const text = Buffer.from(session.sealText('one'), 'base64')
    const binary = session.sealBinary(new Uint8Array([2]))
    expect(text.subarray(16, 24)).toEqual(Buffer.alloc(8, 0))
    expect(binary.subarray(16, 24)).toEqual(Uint8Array.from(Buffer.from('0000000000000001', 'hex')))
  })
})
