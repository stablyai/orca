import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import { sealMobileE2EEV2Frame } from '../../../src/shared/mobile-e2ee-v2-framing'
import { RpcClientRequestTracker } from './rpc-client-request-tracker'
import type { RpcClient } from './rpc-client'
import type { RpcResponse } from './types'
import { fetchMobileWebBundle } from './mobile-web-bundle-fetch'

vi.mock('expo-crypto', async () => {
  const crypto = await import('node:crypto')
  return {
    CryptoDigestAlgorithm: { SHA256: 'sha256' },
    digest: async (_algorithm: string, bytes: Uint8Array) =>
      Uint8Array.from(crypto.createHash('sha256').update(bytes).digest()).buffer
  }
})

import {
  installMobileWebBundleAppPath,
  mobileWebBundleDispatcher
} from '../../../src/main/runtime/rpc/methods/mobile-web-bundle.test-fixture'
import { resetBundledMobileWebBundleCacheForTests } from '../../../src/main/runtime/bundled-mobile-web-bundle'

let scratch: string | undefined

afterEach(() => {
  vi.useRealTimers()
  resetBundledMobileWebBundleCacheForTests()
  if (scratch) {
    rmSync(scratch, { recursive: true, force: true })
  }
})

it('verifies a host-served bundle over a 20 KiB/s link including incompressible assets', async () => {
  scratch = mkdtempSync(join(tmpdir(), 'orca-bundle-slow-link-'))
  installMobileWebBundleAppPath(scratch)
  const root = join(scratch, 'out', 'mobile-web')
  mkdirSync(join(root, 'assets'), { recursive: true })
  const files = new Map([
    ['index.html', Buffer.from('<html>Orca</html>')],
    ['assets/font.woff2', randomBytes(800 * 1024)]
  ])
  const assets = [...files]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([path, bytes]) => ({
      path,
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      contentType: path.endsWith('.html') ? 'text/html' : 'font/woff2'
    }))
  const manifest = {
    schemaVersion: 1,
    buildId: computeMobileWebBundleId(assets),
    desktopVersion: '1.4.232',
    minCompatibleRuntimeProtocolVersion: 2,
    runtimeProtocolVersion: 2,
    entrypoint: 'index.html',
    totalBytes: assets.reduce((sum, asset) => sum + asset.byteLength, 0),
    assets,
    routes: []
  }
  for (const [path, bytes] of files) {
    writeFileSync(join(root, path), bytes)
  }
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))

  const dispatcher = mobileWebBundleDispatcher()
  const invoke = async (method: string, params: unknown): Promise<unknown> => {
    const response = await dispatcher.dispatch(
      { id: 'host-read', authToken: 'tok', method, params },
      { connectionId: 'slow-link' }
    )
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return response.result
  }
  const opened = await invoke('mobileWeb.bundle.manifest', null)
  const grid: unknown = Object(opened).rangeBytes
  if (typeof grid !== 'number') {
    throw new Error('Host did not advertise a range grid')
  }
  // Produce real replies before faking time so filesystem I/O never races the network clock.
  const replies = new Map<string, unknown>()
  for (const asset of assets) {
    for (let offset = 0; offset < asset.byteLength; offset += grid) {
      replies.set(
        `${asset.path}:${offset}`,
        await invoke('mobileWeb.bundle.range', {
          buildId: manifest.buildId,
          path: asset.path,
          offset
        })
      )
    }
  }

  vi.useFakeTimers()
  let freeAt = Date.now()
  let nextId = 0
  let counter = 0n
  const tracker = new RpcClientRequestTracker({
    nextId: () => `slow-${++nextId}`,
    getState: () => 'connected',
    waitForConnected: async () => {},
    sendFrame: (frame) => {
      const params = Object(frame.params)
      const result =
        frame.method === 'mobileWeb.bundle.manifest'
          ? opened
          : replies.get(`${String(params.path)}:${String(params.offset)}`)
      if (result === undefined) {
        throw new Error('Unplanned bundle request')
      }
      const response: RpcResponse = { id: frame.id, ok: true, result, _meta: { runtimeId: 'host' } }
      const sealed = sealMobileE2EEV2Frame({
        payload: Buffer.from(JSON.stringify(response)),
        key: new Uint8Array(32),
        sessionId: new Uint8Array(32),
        direction: 'desktop-to-mobile',
        payloadKind: 'text',
        counter: counter++
      })
      const wireBytes = Buffer.from(sealed).toString('base64').length
      freeAt = Math.max(freeAt, Date.now() + 150) + (wireBytes / (20 * 1024)) * 1000
      setTimeout(() => tracker.resolve(response), freeAt + 150 - Date.now())
      return true
    }
  })
  const client: RpcClient = {
    sendRequest: (method, params, options) => tracker.sendRequest(method, params, options),
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  const outcome = fetchMobileWebBundle({ client }).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error })
  )
  await vi.runAllTimersAsync()
  const { value, error } = await outcome
  expect(error).toBeUndefined()
  expect(value?.assets.size).toBe(files.size)
  for (const [path, bytes] of files) {
    expect(value?.assets.get(path)).toEqual(new Uint8Array(bytes))
  }
  expect(tracker.size()).toBe(0)
}, 15_000)
