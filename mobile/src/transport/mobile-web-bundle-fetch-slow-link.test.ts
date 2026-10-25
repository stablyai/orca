import { sha256 } from '@noble/hashes/sha256'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import { MOBILE_WEB_BUNDLE_WINDOW_STALL_MS, fetchMobileWebBundle } from './mobile-web-bundle-fetch'
import { isMobileWebBundleTransportFailure } from './mobile-web-bundle-operations'
import type { RpcClient } from './rpc-client'
import { RpcClientRequestTracker } from './rpc-client-request-tracker'
import type { RpcRequestFrame } from './rpc-envelope-fields'
import type { RpcResponse } from './types'

// Hashed before it resolves, as the native module's synchronous digest is.
vi.mock('expo-crypto', async () => {
  const { sha256: hash } = await import('@noble/hashes/sha256')
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digest: async (_algorithm: string, data: Uint8Array) => hash(data).buffer
  }
})

// Use a small grid for cheap payload work; model slow-link cost with time rather than bytes.
const RANGE_GRID = 1024
const ONE_WAY_LATENCY_MS = 150
/** One 384 KiB window sealed at ~40 KB/s, the slow relayed path #29697 reported. */
const WINDOW_TRANSFER_MS = 17_000

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

/** Incompressible, like the bundle's images and fonts, so the host sends it as identity. */
function noiseBytes(byteLength: number, seed: number): Uint8Array {
  let state = 0x9e3779b9 ^ seed
  return Uint8Array.from({ length: byteLength }, () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state & 0xff
  })
}

// Serialize replies on one link through the real request tracker; null transfer time stalls after manifest.
function slowLinkHost(files: Record<string, Uint8Array>, windowTransferMs: number | null) {
  const assets = Object.entries(files)
    .map(([path, content]) => ({
      path,
      sha256: toHex(sha256(content)),
      byteLength: content.byteLength,
      contentType: 'image/png'
    }))
    .sort((left, right) => (left.path < right.path ? -1 : 1))
  const buildId = computeMobileWebBundleId(assets)
  const manifest = {
    schemaVersion: 1,
    buildId,
    desktopVersion: '1.4.227',
    minCompatibleRuntimeProtocolVersion: 2,
    runtimeProtocolVersion: 2,
    entrypoint: assets[0]!.path,
    totalBytes: assets.reduce((total, entry) => total + entry.byteLength, 0),
    assets
  }
  const answer = (frame: RpcRequestFrame): unknown => {
    if (frame.method === 'mobileWeb.bundle.manifest') {
      return { manifest, chunkBytes: 48 * 1024, rangeBytes: RANGE_GRID }
    }
    const params: Record<string, unknown> = Object(frame.params)
    const path = String(params.path)
    const offset = Number(params.offset)
    const content = files[path]!
    const slice = content.subarray(offset, offset + RANGE_GRID)
    return {
      buildId,
      path,
      offset,
      assetByteLength: content.byteLength,
      sha256: toHex(sha256(content)),
      eof: offset + slice.byteLength >= content.byteLength,
      encoding: 'identity',
      dataBase64: encodeBase64(slice)
    }
  }

  let linkFreeAt = 0
  let nextId = 0
  let delivered = 0
  const tracker: RpcClientRequestTracker = new RpcClientRequestTracker({
    nextId: () => `rpc-${(nextId += 1)}`,
    getState: () => 'connected',
    waitForConnected: async () => {},
    sendFrame: (frame) => {
      const response: RpcResponse = {
        id: frame.id,
        ok: true,
        result: answer(frame),
        _meta: { runtimeId: 'r' }
      }
      const isManifest = frame.method === 'mobileWeb.bundle.manifest'
      if (!isManifest && windowTransferMs === null) {
        return true
      }
      const now = Date.now()
      const startsAt = Math.max(now + ONE_WAY_LATENCY_MS, linkFreeAt)
      linkFreeAt = isManifest ? startsAt : startsAt + (windowTransferMs ?? 0)
      setTimeout(
        () => {
          delivered += 1
          tracker.resolve(response)
        },
        linkFreeAt + ONE_WAY_LATENCY_MS - now
      )
      return true
    }
  })
  const client: RpcClient = {
    sendRequest: (method, params, options) => tracker.sendRequest(method, params, options),
    subscribe: vi.fn(() => () => {}),
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    onStateChange: () => () => {},
    notifyForeground: vi.fn(),
    close: vi.fn()
  }
  return { client, delivered: () => delivered, pending: () => tracker.size() }
}

function bundleFiles(): Record<string, Uint8Array> {
  return Object.fromEntries(
    [0, 1, 2, 3].map((seed) => [`assets/image-${seed}.png`, noiseBytes(RANGE_GRID * 3, seed)])
  )
}

async function settle<T>(
  promise: Promise<T>
): Promise<{ value?: T; error?: unknown; settledAt: number }> {
  const outcome = promise.then(
    (value) => ({ value, settledAt: Date.now() }),
    (error: unknown) => ({ error, settledAt: Date.now() })
  )
  await vi.runAllTimersAsync()
  return outcome
}

describe('fetchMobileWebBundle over a slow link', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('finishes when every reply lands within the stall budget but four queued ones do not', async () => {
    // Each window lands 17s after the one before it, so the fourth read in flight waits ~68s.
    const files = bundleFiles()
    const host = slowLinkHost(files, WINDOW_TRANSFER_MS)

    const outcome = await settle(fetchMobileWebBundle({ client: host.client }))

    expect(outcome.error).toBeUndefined()
    expect(outcome.value?.assets.size).toBe(4)
    for (const [path, content] of Object.entries(files)) {
      expect(outcome.value?.assets.get(path)).toEqual(content)
    }
  })

  it('fails as a lost link once no window has landed for the stall budget', async () => {
    const host = slowLinkHost(bundleFiles(), null)
    const startedAt = Date.now()

    const outcome = await settle(fetchMobileWebBundle({ client: host.client }))

    expect(isMobileWebBundleTransportFailure(outcome.error)).toBe(true)
    expect(String(outcome.error)).toContain('stalled')
    // Fail against fetch-wide inactivity, not the per-read backstop.
    expect(outcome.settledAt - startedAt).toBeLessThan(MOBILE_WEB_BUNDLE_WINDOW_STALL_MS + 1_000)
    expect(host.delivered()).toBe(1)
    // Pending reads retain reassembly buffers and must settle soon after fetch failure.
    expect(host.pending()).toBe(0)
    expect(Date.now() - startedAt).toBeLessThanOrEqual(6 * MOBILE_WEB_BUNDLE_WINDOW_STALL_MS)
  })
})
