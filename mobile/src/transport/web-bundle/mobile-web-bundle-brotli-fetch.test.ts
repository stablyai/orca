import { sha256 } from '@noble/hashes/sha256'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { computeMobileWebBundleId } from '../../../../src/shared/mobile-web-bundle/manifest-contract'
import { fetchMobileWebBundle, type MobileWebBundleFetchProgress } from './mobile-web-bundle-fetch'

import type { RpcClient } from '../rpc/rpc-client-contract'
import type { RpcResponse } from '../rpc/rpc-wire-types'

vi.mock('expo-crypto', async () => {
  const { sha256: hash } = await import('@noble/hashes/sha256')
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digest: async (_algorithm: string, data: Uint8Array) => hash(data).buffer
  }
})

// The native codec as a phone binary has it; node's brotli stands in for the platform decoder.
vi.mock('../encryption/paired-e2ee-native-codec', () => ({
  pairedE2EENativeCodec: () => ({
    decodeBase64: (value: string) => new Uint8Array(Buffer.from(value, 'base64')),
    brotliDecompress: async (input: Uint8Array, outputLimit: number) =>
      new Uint8Array(brotliDecompressSync(input)).slice(0, outputLimit)
  })
}))

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

// Small enough that the 46-byte brotli copy spans three windows.
const RANGE_BYTES = 16
const SCRIPT = 'export const greeting = "hello";\n'.repeat(40)
const MARK = 'a short mark'

function brotliHost() {
  const files = new Map([
    ['assets/script.js', new TextEncoder().encode(SCRIPT)],
    ['index.html', new TextEncoder().encode(MARK)]
  ])
  const copy = new Uint8Array(brotliCompressSync(files.get('assets/script.js')!))
  const assets = [...files].map(([path, content]) => ({
    path,
    sha256: toHex(sha256(content)),
    byteLength: content.byteLength,
    contentType: 'text/plain',
    ...(path === 'assets/script.js' ? { brotliByteLength: copy.byteLength } : {})
  }))
  const buildId = computeMobileWebBundleId(assets)
  const manifest = {
    schemaVersion: 1,
    buildId,
    desktopVersion: '1.4.300',
    minCompatibleRuntimeProtocolVersion: 2,
    runtimeProtocolVersion: 2,
    entrypoint: 'index.html',
    totalBytes: assets.reduce((total, entry) => total + entry.byteLength, 0),
    assets
  }
  const methods: string[] = []
  const answer = (method: string, params: Record<string, unknown>): unknown => {
    if (method === 'mobileWeb.bundle.manifest') {
      return { manifest, chunkBytes: RANGE_BYTES, rangeBytes: RANGE_BYTES }
    }
    const path = String(params.path)
    const offset = Number(params.offset)
    const content = files.get(path)!
    const stream = method === 'mobileWeb.bundle.brotliRange' ? copy : content
    const slice = stream.subarray(offset, offset + RANGE_BYTES)
    return {
      buildId,
      path,
      offset,
      assetByteLength: content.byteLength,
      sha256: toHex(sha256(content)),
      ...(method === 'mobileWeb.bundle.range' ? { encoding: 'identity' } : {}),
      dataBase64: Buffer.from(slice).toString('base64'),
      eof: offset + slice.byteLength >= stream.byteLength
    }
  }
  const client: RpcClient = {
    sendRequest: vi.fn(async (method: string, params?: unknown): Promise<RpcResponse> => {
      methods.push(method)
      const fields: Record<string, unknown> = Object(params)
      return { id: 'rpc-1', ok: true, result: answer(method, fields), _meta: { runtimeId: 'r' } }
    }),
    subscribe: vi.fn(() => () => {}),
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    onStateChange: () => () => {},
    notifyForeground: vi.fn(),
    close: vi.fn()
  }
  return { client, methods }
}

describe('fetchMobileWebBundle from a host that ships brotli copies', () => {
  it('reads the copy where the manifest lists one, inflates it, and reports progress in the bytes it moves', async () => {
    const host = brotliHost()
    const progress: MobileWebBundleFetchProgress[] = []

    const fetched = await fetchMobileWebBundle({
      client: host.client,
      onProgress: (update) => progress.push(update)
    })

    expect(new TextDecoder().decode(fetched.assets.get('assets/script.js'))).toBe(SCRIPT)
    expect(new TextDecoder().decode(fetched.assets.get('index.html'))).toBe(MARK)
    expect(host.methods.filter((method) => method === 'mobileWeb.bundle.brotliRange')).toHaveLength(
      3
    )
    expect(host.methods.filter((method) => method === 'mobileWeb.bundle.range')).toHaveLength(1)
    // The 46-byte copy plus the 12-byte mark, not the 1,332 bytes they inflate to.
    expect(progress.at(-1)).toMatchObject({ receivedBytes: 58, totalBytes: 58 })
  })
})
