import { describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import {
  encodeMobileE2EEV2Transcript,
  validateMobileE2EEV2Handshake,
  type MobileE2EEV2Ready
} from '../../../src/shared/mobile-e2ee-v2-contract'
import { sealMobileE2EEV2Frame } from '../../../src/shared/mobile-e2ee-v2-framing'

vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(9)
}))

import { deriveSharedKey } from './e2ee'
import { MobileE2EEV2ClientSession } from './mobile-e2ee-v2-client-session'
import { deriveMobileE2EEV2KeySchedule } from './mobile-e2ee-v2-key-schedule'

const desktop = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(1))
const client = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(2))

function setup() {
  const session = MobileE2EEV2ClientSession.create({
    desktopPublicKeyB64: Buffer.from(desktop.publicKey).toString('base64'),
    transport: 'relay',
    relayHostId: 'AbCdEf0123_-xyZ9',
    clientNonce: new Uint8Array(32).fill(3),
    clientKeyPair: client
  })
  const ready: MobileE2EEV2Ready = {
    type: 'e2ee_ready',
    v: 2,
    desktopPublicKeyB64: Buffer.from(desktop.publicKey).toString('base64'),
    clientNonceB64: session.hello.clientNonceB64,
    desktopNonceB64: Buffer.from(new Uint8Array(32).fill(4)).toString('base64'),
    selection: { framing: 2, payloadKinds: ['text', 'binary'] },
    context: session.hello.context
  }
  return { session, ready }
}

function pairedSession() {
  const { session, ready } = setup()
  expect(session.acceptReady(ready)).toBe(true)
  const handshake = validateMobileE2EEV2Handshake(session.hello, ready)
  if (!handshake) {
    throw new Error('Fixture handshake failed')
  }
  const schedule = deriveMobileE2EEV2KeySchedule({
    sharedSecret: deriveSharedKey(desktop.secretKey, client.publicKey),
    transcript: encodeMobileE2EEV2Transcript(handshake),
    clientNonce: handshake.clientNonce,
    desktopNonce: handshake.desktopNonce
  })
  return { session, schedule }
}

function desktopTextFrame(
  plaintext: string,
  schedule: ReturnType<typeof deriveMobileE2EEV2KeySchedule>
): string {
  return Buffer.from(
    sealMobileE2EEV2Frame({
      payload: new TextEncoder().encode(plaintext),
      key: schedule.desktopToMobileKey,
      sessionId: schedule.sessionId,
      direction: 'desktop-to-mobile',
      payloadKind: 'text',
      counter: 0n
    })
  ).toString('base64')
}

describe('mobile E2EE v2 client session', () => {
  it('pins the desktop key and accepts the exact transcript', () => {
    const { session, ready } = setup()
    expect(session.acceptReady(ready)).toBe(true)
    expect(session.transcriptHashB64).toHaveLength(44)
    expect(
      session.acceptReady({
        ...ready,
        desktopPublicKeyB64: Buffer.from(new Uint8Array(32).fill(8)).toString('base64')
      })
    ).toBe(false)
  })

  it('seals auth at counter zero and rejects replayed desktop frames', () => {
    const { session, schedule } = pairedSession()
    const auth = JSON.stringify({
      type: 'e2ee_auth',
      v: 2,
      transcriptHashB64: session.transcriptHashB64,
      deviceToken: 'token'
    })
    const authFrame = Buffer.from(session.sealText(auth), 'base64')
    expect(authFrame.subarray(16, 24)).toEqual(Buffer.alloc(8, 0))

    const encoded = desktopTextFrame('authenticated', schedule)
    expect(session.openText(encoded)).toBe('authenticated')
    expect(session.openText(encoded)).toBeNull()
  })

  it('rejects noncanonical encodings without consuming the valid frame', () => {
    const { session, schedule } = pairedSession()
    const plaintext = 'canonical padding!'
    const encoded = desktopTextFrame(plaintext, schedule)
    expect(encoded.endsWith('=')).toBe(true)
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const paddingOffset = encoded.indexOf('=')
    const lastDigit = alphabet.indexOf(encoded[paddingOffset - 1]!)
    const nonzeroPadding =
      encoded.slice(0, paddingOffset - 1) + alphabet[lastDigit ^ 1] + encoded.slice(paddingOffset)
    expect(Buffer.from(nonzeroPadding, 'base64')).toEqual(Buffer.from(encoded, 'base64'))
    for (const alias of [
      ` ${encoded}`,
      `${encoded}\n`,
      encoded.replace(/=+$/, ''),
      nonzeroPadding,
      encoded.replace(/[+/]/g, '_'),
      '!invalid base64'
    ]) {
      expect(alias).not.toBe(encoded)
      expect(session.openText(alias)).toBeNull()
    }
    expect(session.openText(encoded)).toBe(plaintext)
  })

  it('preserves full large text frames with bounded binary string conversions', () => {
    const { session, schedule } = pairedSession()
    const plaintext = 'a'.repeat(2 * 1024 * 1024)
    const incoming = desktopTextFrame(plaintext, schedule)
    const expectedOutgoing = Buffer.from(
      sealMobileE2EEV2Frame({
        payload: new TextEncoder().encode(plaintext),
        key: schedule.mobileToDesktopKey,
        sessionId: schedule.sessionId,
        direction: 'mobile-to-desktop',
        payloadKind: 'text',
        counter: 0n
      })
    ).toString('base64')
    const encode = vi.spyOn(globalThis, 'btoa')
    try {
      expect(session.sealText(plaintext)).toBe(expectedOutgoing)
      expect(session.openText(incoming)).toBe(plaintext)
      const largestBinaryString = encode.mock.calls.reduce(
        (largest, [binary]) => Math.max(largest, binary.length),
        0
      )
      expect(largestBinaryString).toBeGreaterThan(0)
      expect(largestBinaryString).toBeLessThanOrEqual(16 * 1024)
    } finally {
      encode.mockRestore()
    }
  })
})
