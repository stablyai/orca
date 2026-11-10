import { sha256 } from '@noble/hashes/sha256'
import { describe, expect, it, vi } from 'vitest'
import { computeMobileWebBundleId } from '../../../../src/shared/mobile-web-bundle/manifest-contract'
import { fetchMobileWebBundle } from './mobile-web-bundle-fetch'
import { MobileWebBundleFetchError } from './mobile-web-bundle-fetch-refusal'

import type { RpcClient } from '../rpc/rpc-client-contract'
import type { RpcResponse } from '../rpc/rpc-wire-types'

// Hashed before it resolves, as the native module's synchronous digest is.
vi.mock('expo-crypto', async () => {
  const { sha256: hash } = await import('@noble/hashes/sha256')
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digest: async (_algorithm: string, data: Uint8Array) => hash(data).buffer
  }
})

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

type HostCall = { method: string; params: unknown }

type HostOptions = {
  chunkBytes?: number
  buildId?: string
  intercept?: (call: HostCall) => unknown
  onInFlight?: (inFlight: number) => void
  catalogs?: readonly string[]
}

/** Box first, so params that are not an object read as absent instead of throwing. */
function paramField(params: unknown, key: string): unknown {
  const boxed: Record<string, unknown> = Object(params)
  return boxed[key]
}

function bundleHost(files: Record<string, string>, options: HostOptions = {}) {
  const chunkBytes = options.chunkBytes ?? 4
  const bytes = new Map(Object.entries(files).map(([path, text]) => [path, bytesOf(text)]))
  const assets = [...bytes.entries()]
    .map(([path, content]) => ({
      path,
      sha256: toHex(sha256(content)),
      byteLength: content.byteLength,
      contentType: 'text/plain',
      ...(options.catalogs?.includes(path) ? { kind: 'catalog' } : {})
    }))
    .sort((left, right) => (left.path < right.path ? -1 : 1))
  // Derive fixture ids from final asset lists unless the test explicitly selects a mismatch.
  const buildId = options.buildId ?? computeMobileWebBundleId(assets)
  const manifest = {
    schemaVersion: 1,
    buildId,
    desktopVersion: '1.4.200',
    minCompatibleRuntimeProtocolVersion: 2,
    runtimeProtocolVersion: 2,
    entrypoint: assets[0]!.path,
    totalBytes: assets.reduce((total, entry) => total + entry.byteLength, 0),
    assets
  }
  const calls: HostCall[] = []
  let inFlight = 0

  const answer = (method: string, params: unknown): unknown => {
    if (method === 'mobileWeb.bundle.manifest') {
      return { manifest, chunkBytes }
    }
    const path = String(paramField(params, 'path'))
    const offset = Number(paramField(params, 'offset'))
    const content = bytes.get(path)!
    const slice = content.subarray(offset, offset + chunkBytes)
    return {
      buildId,
      path,
      offset,
      assetByteLength: content.byteLength,
      sha256: toHex(sha256(content)),
      dataBase64: encodeBase64(slice),
      eof: offset + slice.byteLength >= content.byteLength
    }
  }

  const client: RpcClient = {
    sendRequest: vi.fn(async (method: string, params?: unknown): Promise<RpcResponse> => {
      const call: HostCall = { method, params: params ?? {} }
      calls.push(call)
      inFlight += 1
      options.onInFlight?.(inFlight)
      try {
        await new Promise((resolve) => setTimeout(resolve, 0))
        const replaced = options.intercept?.(call)
        const result = replaced === undefined ? answer(method, call.params) : replaced
        if (result instanceof Error) {
          return {
            id: 'rpc-1',
            ok: false,
            error: { code: 'invalid_argument', message: result.message },
            _meta: { runtimeId: 'runtime-1' }
          }
        }
        return { id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
      } finally {
        inFlight -= 1
      }
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
  return { client, calls, manifest }
}

async function refusalOf(failed: Promise<unknown>): Promise<string | null> {
  const error = await failed.then(
    () => null,
    (thrown: unknown) => thrown
  )
  return error instanceof MobileWebBundleFetchError ? error.refusal : null
}

describe('fetchMobileWebBundle', () => {
  it('fails when a reassembled asset does not hash to the manifest entry', async () => {
    const host = bundleHost(
      { 'index.html': 'abcdef' },
      {
        chunkBytes: 3,
        intercept: (call) =>
          call.method === 'mobileWeb.bundle.chunk' && paramField(call.params, 'offset') === 3
            ? {
                buildId: host.manifest.buildId,
                path: 'index.html',
                offset: 3,
                assetByteLength: 6,
                sha256: toHex(sha256(bytesOf('abcdef'))),
                dataBase64: encodeBase64(bytesOf('XYZ')),
                eof: true
              }
            : undefined
      }
    )

    const failed = fetchMobileWebBundle({ client: host.client })
    await expect(failed).rejects.toThrow(/index\.html hashed [0-9a-f]{64}, not/)
    expect(await refusalOf(failed)).toBe('asset-checksum-mismatch')
  })

  it('leaves language-catalog chunks on the desktop and fetches the rest', async () => {
    const host = bundleHost(
      { 'index.html': 'abcdef', 'assets/de.js': 'catalog' },
      { catalogs: ['assets/de.js'] }
    )

    const fetched = await fetchMobileWebBundle({ client: host.client })

    expect([...fetched.assets.keys()]).toEqual(['index.html'])
    expect(host.calls.some((call) => paramField(call.params, 'path') === 'assets/de.js')).toBe(
      false
    )
  })
})
