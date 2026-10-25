import { gunzipSync } from 'node:zlib'
import sodium from 'react-native-libsodium'
import nacl from 'tweetnacl'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  encodeMobileE2EEV2Transcript,
  validateMobileE2EEV2Handshake,
  type MobileE2EEV2Ready
} from '../../../src/shared/mobile-e2ee-v2-contract'
import { sealMobileE2EEV2Frame } from '../../../src/shared/mobile-e2ee-v2-framing'
import type { PairedE2EEPrimitives } from '../../../src/shared/paired-e2ee-primitives'
import { PairedE2EEV2ClientSession } from '../../../src/shared/paired-e2ee-v2-client-session'
import { derivePairedE2EEV2KeySchedule } from '../../../src/shared/paired-e2ee-v2-key-schedule'
import type { PairedE2EENativeBindings } from './paired-e2ee-native-codec'

// Use the package’s wasm libsodium under Node; Kotlin/Swift tests pin the separate codec stand-in.
const secretboxOpenCalls = vi.fn()
let bindings: PairedE2EENativeBindings | null = null

function libsodiumBindings(): PairedE2EENativeBindings {
  return {
    sodium: {
      fromBase64: (value, variant) => sodium.from_base64(value, variant).slice().buffer,
      secretboxOpen: (box, nonce, key) => {
        secretboxOpenCalls(box.byteLength)
        return sodium
          .crypto_secretbox_open_easy(
            new Uint8Array(box),
            new Uint8Array(nonce),
            new Uint8Array(key)
          )
          .slice().buffer
      }
    },
    codec: {
      gunzip: (input, outputLimit) => new Uint8Array(gunzipSync(input)).slice(0, outputLimit),
      decodeUtf8: (input) => {
        if (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
          return null
        }
        try {
          return new TextDecoder('utf-8', { fatal: true }).decode(input)
        } catch {
          return null
        }
      }
    }
  }
}

async function load(withNative: boolean) {
  bindings = withNative ? libsodiumBindings() : null
  vi.resetModules()
  const codec = await import('./paired-e2ee-native-codec')
  if (withNative) {
    codec.providePairedE2EENativeBindings(() => bindings)
  }
  const primitives = await import('./mobile-paired-e2ee-primitives')
  return {
    primitives: primitives.MOBILE_PAIRED_E2EE_PRIMITIVES,
    native: codec.pairedE2EENativeCodec()
  }
}

const desktop = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(1))
const client = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(2))
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

function pairedSession(primitives: PairedE2EEPrimitives) {
  const session = PairedE2EEV2ClientSession.create({
    primitives,
    desktopPublicKeyB64: b64(desktop.publicKey),
    transport: 'relay',
    relayHostId: 'AbCdEf0123_-xyZ9',
    clientNonce: new Uint8Array(32).fill(3),
    clientKeyPair: client
  })
  const ready: MobileE2EEV2Ready = {
    type: 'e2ee_ready',
    v: 2,
    desktopPublicKeyB64: b64(desktop.publicKey),
    clientNonceB64: session.hello.clientNonceB64,
    desktopNonceB64: b64(new Uint8Array(32).fill(4)),
    selection: { framing: 2, payloadKinds: ['text', 'binary'] },
    context: session.hello.context
  }
  expect(session.acceptReady(ready)).toBe(true)
  const handshake = validateMobileE2EEV2Handshake(session.hello, ready)!
  const schedule = derivePairedE2EEV2KeySchedule({
    sharedSecret: nacl.box.before(client.publicKey, desktop.secretKey),
    transcript: encodeMobileE2EEV2Transcript(handshake),
    clientNonce: handshake.clientNonce,
    desktopNonce: handshake.desktopNonce
  })
  return { session, schedule }
}

let seed = 7
function random(below: number): number {
  seed = (seed * 1103515245 + 12345) % 2 ** 31
  // Why the shift: an LCG's low bits cycle with short periods.
  return Math.floor(seed / 256) % below
}
function randomBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, () => random(256))
}

const PAYLOADS = [
  '{"id":1,"result":{"ok":true}}',
  '',
  '\uFEFF{"bom":"stripped by TextDecoder"}',
  'é✓🙂 μ',
  JSON.stringify({ dataBase64: b64(randomBytes(150_000)) })
]

function inboundWire(schedule: ReturnType<typeof derivePairedE2EEV2KeySchedule>) {
  const wire: { frame: string; plaintext: string | null }[] = []
  const seal = (payload: string, counter: bigint, key = schedule.desktopToMobileKey) =>
    sealMobileE2EEV2Frame({
      payload: new TextEncoder().encode(payload),
      key,
      sessionId: schedule.sessionId,
      direction: 'desktop-to-mobile',
      payloadKind: 'text',
      counter
    })
  const flipped = (frame: Uint8Array, index: number) => {
    const copy = frame.slice()
    copy[index]! ^= 1 << random(8)
    return copy
  }
  PAYLOADS.forEach((payload, index) => {
    const counter = BigInt(index)
    const good = seal(payload, counter)
    const goodB64 = b64(good)
    const bad = [
      flipped(good, random(24)),
      flipped(good, 24 + random(16)),
      flipped(good, 40 + random(good.length - 40)),
      good.subarray(0, -1),
      good.subarray(0, 81),
      good.subarray(0, 30),
      seal(payload, counter, randomBytes(32)),
      seal(payload, counter + 1n)
    ].map(b64)
    const nonCanonical = [
      goodB64.replace(/=+$/, ''),
      `${goodB64.slice(0, 8)}\n${goodB64.slice(8)}`,
      `${goodB64} `,
      goodB64.replaceAll('+', '-').replaceAll('/', '_'),
      `${goodB64}=`
    ].filter((variant) => variant !== goodB64)
    for (const frame of [...bad, ...nonCanonical]) {
      wire.push({ frame, plaintext: null })
    }
    wire.push({
      frame: goodB64,
      plaintext: new TextDecoder().decode(new TextEncoder().encode(payload))
    })
  })
  return wire
}

describe('the native paired E2EE codec', () => {
  beforeAll(async () => {
    await sodium.ready
  })

  it('opens and refuses exactly the frames the JS paths do, never advancing on a refusal', async () => {
    const { primitives: nativePrimitives, native } = await load(true)
    const { primitives: fallbackPrimitives, native: absent } = await load(false)
    expect(native).not.toBeNull()
    expect(absent).toBeNull()
    const originalPrimitives: PairedE2EEPrimitives = {
      ...fallbackPrimitives,
      openSecretbox: undefined,
      decodeCanonicalBase64: undefined,
      decodeUtf8: undefined
    }
    const sessions = [nativePrimitives, fallbackPrimitives, originalPrimitives].map((primitives) =>
      pairedSession(primitives)
    )
    const wire = inboundWire(sessions[0]!.schedule)
    expect(wire.filter((entry) => entry.plaintext === null).length).toBeGreaterThan(50)
    for (const { session } of sessions) {
      expect(wire.map(({ frame }) => session.openText(frame))).toEqual(
        wire.map(({ plaintext }) => plaintext)
      )
    }
  })

  it('uses native once provided, even after a lookup with no provider', async () => {
    const { native: before } = await load(false)
    expect(before).toBeNull()
    const codec = await import('./paired-e2ee-native-codec')
    bindings = libsodiumBindings()
    codec.providePairedE2EENativeBindings(() => bindings)
    expect(codec.pairedE2EENativeCodec()).not.toBeNull()
  })

  it('agrees with tweetnacl on boxes either library sealed', async () => {
    const { native } = await load(true)
    for (let index = 0; index < 300; index++) {
      const key = randomBytes(32)
      const nonce = randomBytes(24)
      const message = randomBytes(random(600))
      const boxes = [
        sodium.crypto_secretbox_easy(message, nonce, key),
        nacl.secretbox(message, nonce, key)
      ]
      expect(boxes[0]).toEqual(boxes[1])
      for (const box of boxes) {
        expect(native!.openSecretbox(box, nonce, key)).toEqual(message)
        const tampered = box.slice()
        tampered[random(box.length)]! ^= 1 << random(8)
        expect(native!.openSecretbox(tampered, nonce, key)).toBeNull()
        expect(nacl.secretbox.open(tampered, nonce, key)).toBeNull()
      }
    }
  })

  // UTF-8 fallback must preserve an already-opened frame whose counter advanced.
  it('falls back to TextDecoder when native UTF-8 throws', async () => {
    const { primitives } = await load(true)
    bindings!.codec.decodeUtf8 = () => {
      throw new Error('native UTF-8 failed')
    }
    const { session, schedule } = pairedSession(primitives)
    const frames = ['{"a":1}', 'é✓🙂'].map((payload, counter) =>
      b64(
        sealMobileE2EEV2Frame({
          payload: new TextEncoder().encode(payload),
          key: schedule.desktopToMobileKey,
          sessionId: schedule.sessionId,
          direction: 'desktop-to-mobile',
          payloadKind: 'text',
          counter: BigInt(counter)
        })
      )
    )
    expect(frames.map((frame) => session.openText(frame))).toEqual(['{"a":1}', 'é✓🙂'])
  })

  // libsodium sizes its output as the box length minus the MAC, which underflows and crashes.
  it('never hands libsodium a box shorter than its MAC', async () => {
    const { native } = await load(true)
    secretboxOpenCalls.mockClear()
    for (let length = 0; length < 16; length++) {
      expect(
        native!.openSecretbox(new Uint8Array(length), randomBytes(24), randomBytes(32))
      ).toBeNull()
    }
    expect(secretboxOpenCalls).not.toHaveBeenCalled()
  })

  it('accepts exactly the base64 that re-encodes to itself, on both paths', async () => {
    const { native, primitives } = await load(true)
    const { primitives: fallback } = await load(false)
    const reencodes = (value: string) => {
      try {
        const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
        return b64(bytes) === value ? bytes : null
      } catch {
        return null
      }
    }
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const noise = `${alphabet}=-_ \n\t.`
    const cases = [
      '',
      'QR==',
      'QQ==',
      'QQ',
      'QQ=',
      'Q===',
      '====',
      'QUJD',
      'QUJ D',
      'Q=Q=',
      '-_8=',
      'AB+/'
    ]
    for (let index = 0; index < 5_000; index++) {
      let value = b64(randomBytes(random(10)))
      if (random(2) === 0) {
        const at = random(value.length + 1)
        value = value.slice(0, at) + noise[random(noise.length)] + value.slice(at + 1)
      }
      cases.push(value)
    }
    for (const value of cases) {
      const expected = reencodes(value)
      expect(native!.decodeBase64(value), value).toEqual(expected)
      expect(primitives.decodeCanonicalBase64!(value), value).toEqual(expected)
      expect(fallback.decodeCanonicalBase64!(value), value).toEqual(expected)
    }
  })
})
