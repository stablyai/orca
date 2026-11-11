import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import sodium from 'react-native-libsodium'

import { beforeAll, describe, expect, it, vi } from 'vitest'

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
      brotliDecompress: async (input, outputLimit) =>
        new Uint8Array(brotliDecompressSync(input)).slice(0, outputLimit),
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

let seed = 7
function random(below: number): number {
  seed = (seed * 1103515245 + 12345) % 2 ** 31
  // Why the shift: an LCG's low bits cycle with short periods.
  return Math.floor(seed / 256) % below
}
function randomBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, () => random(256))
}

describe('the native paired E2EE codec', () => {
  beforeAll(async () => {
    await sodium.ready
  })

  // UTF-8 fallback must preserve an already-opened frame whose counter advanced.

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
