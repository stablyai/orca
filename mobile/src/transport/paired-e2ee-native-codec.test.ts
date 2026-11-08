import { gunzipSync } from 'node:zlib'
import sodium from 'react-native-libsodium'
import nacl from 'tweetnacl'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  encodeMobileE2EEV2Transcript,
  validateMobileE2EEV2Handshake,
  type MobileE2EEV2Ready
} from '../../../src/shared/remote-runtime/e2ee/mobile-e2ee-v2-contract'
import { sealMobileE2EEV2Frame } from '../../../src/shared/remote-runtime/e2ee/mobile-e2ee-v2-framing'
import type { PairedE2EEPrimitives } from '../../../src/shared/remote-runtime/e2ee/paired-e2ee-primitives'
import { PairedE2EEV2ClientSession } from '../../../src/shared/remote-runtime/e2ee/paired-e2ee-v2-client-session'
import { derivePairedE2EEV2KeySchedule } from '../../../src/shared/remote-runtime/e2ee/paired-e2ee-v2-key-schedule'
import type { PairedE2EENativeBindings } from './paired-e2ee-native-codec'

// Use the package’s wasm libsodium under Node; Kotlin/Swift tests pin the separate codec stand-in.
const secretboxOpenCalls = vi.fn()
const secretboxSealCalls = vi.fn()
let bindings: PairedE2EENativeBindings | null = null

function libsodiumBindings(): PairedE2EENativeBindings {
  return {
    sodium: {
      fromBase64: (value, variant) => sodium.from_base64(value, variant).slice().buffer,
      toBase64: (value, variant) => sodium.to_base64(new Uint8Array(value), variant),
      secretboxSeal: (message, nonce, key) => {
        secretboxSealCalls(message.byteLength)
        return sodium
          .crypto_secretbox_easy(
            new Uint8Array(message),
            new Uint8Array(nonce),
            new Uint8Array(key)
          )
          .slice().buffer
      },
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
    const wire = inboundWire(pairedSession((await load(true)).primitives).schedule)
    expect(wire.filter((entry) => entry.plaintext === null).length).toBeGreaterThan(50)
    for (const mode of ['native', 'fallback', 'original']) {
      const { primitives, native } = await load(mode === 'native')
      expect(native === null).toBe(mode !== 'native')
      const originalPrimitives: PairedE2EEPrimitives = {
        ...primitives,
        openSecretbox: undefined,
        decodeCanonicalBase64: undefined,
        decodeUtf8: undefined
      }
      const { session } = pairedSession(mode === 'original' ? originalPrimitives : primitives)
      secretboxOpenCalls.mockClear()
      expect(wire.map(({ frame }) => session.openText(frame))).toEqual(
        wire.map(({ plaintext }) => plaintext)
      )
      if (mode === 'native') {
        expect(secretboxOpenCalls).toHaveBeenCalled()
      } else {
        expect(secretboxOpenCalls).not.toHaveBeenCalled()
      }
    }
  })

  it('seals through native exactly the frames tweetnacl seals', async () => {
    const { native } = await load(true)
    const key = Uint8Array.from({ length: 32 }, (_, index) => index)
    const nonce = Uint8Array.from({ length: 24 }, (_, index) => index)
    const box = native!.sealSecretbox(new TextEncoder().encode('ok'), nonce, key)
    expect(native!.encodeBase64(box)).toBe('sqQBX9c2fQaZ4F6j8gHDpjGU')
    expect(new TextDecoder().decode(nacl.secretbox.open(box, nonce, key)!)).toBe('ok')

    const sealed: string[][] = []
    for (const mode of ['native', 'original']) {
      const { primitives } = await load(mode === 'native')
      const { session } = pairedSession(primitives)
      secretboxSealCalls.mockClear()
      sealed.push(PAYLOADS.map((payload) => session.sealText(payload)))
      if (mode === 'native') {
        expect(secretboxSealCalls).toHaveBeenCalled()
      } else {
        expect(secretboxSealCalls).not.toHaveBeenCalled()
      }
    }
    expect(sealed[0]).toEqual(sealed[1])
  })

  it('uses native once provided, even after a lookup with no provider', async () => {
    const { native: before } = await load(false)
    expect(before).toBeNull()
    const codec = await import('./paired-e2ee-native-codec')
    bindings = libsodiumBindings()
    codec.providePairedE2EENativeBindings(() => bindings)
    expect(codec.pairedE2EENativeCodec()).not.toBeNull()
  })

  // UTF-8 fallback must preserve an already-opened frame whose counter advanced.
  it('falls back to TextDecoder when native UTF-8 throws', async () => {
    const { primitives, native } = await load(true)
    expect(native).not.toBeNull()
    const decodeUtf8 = vi.spyOn(bindings!.codec, 'decodeUtf8').mockImplementation(() => {
      throw new Error('native UTF-8 failed')
    })
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
    expect(decodeUtf8).toHaveBeenCalledTimes(2)
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
})
