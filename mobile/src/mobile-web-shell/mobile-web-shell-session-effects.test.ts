import { describe, expect, it, vi } from 'vitest'
import type { MobileWebShellSessionEvent } from './mobile-web-shell-session-contract'

const doubles = vi.hoisted(() => ({
  manifest: (): Promise<unknown> => Promise.reject(new Error('no manifest staged')),
  fetch: (): Promise<unknown> => Promise.reject(new Error('no fetch staged'))
}))

vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: '' } }))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
// The runner's deadlines live in the runtime module, whose foreground timer reads React Native's AppState.
vi.mock('./foreground-timer', () => ({ setForegroundTimer: () => () => {} }))
vi.mock('../transport/rpc/rpc-operation', () => ({
  defineRpcOperation: (definition: unknown) => definition,
  runRpcOperation: () => doubles.manifest()
}))
vi.mock('../transport/web-bundle/mobile-web-bundle-fetch', () => ({
  fetchMobileWebBundle: () => doubles.fetch()
}))

import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import type { MobileWebBundleFetchResult } from '../transport/web-bundle/mobile-web-bundle-fetch'
import { createGenerationStore, type GenerationStore } from './generations/generation-store'
import { createFakeGenerationFileSystem } from './generations/generation-file-system-fake'
import { deriveHostCacheKey } from './generations/host-cache-key'
import { download } from './mobile-web-shell-session-effects'

const CLIENT: RpcClient = {
  sendRequest: async () => {
    throw new Error('unused')
  },
  subscribe: () => () => {},
  updateTerminalSubscriptionViewport: () => {},
  getState: () => 'connected',
  getReconnectAttempt: () => 0,
  getLastConnectedAt: () => 1,
  onStateChange: () => () => {},
  notifyForeground: () => {},
  close: () => {}
}

const MANIFEST = {
  schemaVersion: 1,
  buildId: 'c'.repeat(64),
  minCompatibleRuntimeProtocolVersion: 2,
  runtimeProtocolVersion: 5,
  entrypoint: 'index.html',
  totalBytes: 1,
  assets: [{ path: 'index.html', sha256: '1'.repeat(64), byteLength: 1, contentType: 'text/html' }]
}

function collect(): {
  events: MobileWebShellSessionEvent[]
  send: (e: MobileWebShellSessionEvent) => void
} {
  const events: MobileWebShellSessionEvent[] = []
  return { events, send: (event) => events.push(event) }
}

// Use the real store queue: reused-asset copies must survive concurrent mounts sweeping staging during download.
describe('a download that reuses the cached generation', () => {
  const HOST = deriveHostCacheKey('host-a')

  function bundle(pageBytes: number): MobileWebBundleFetchResult {
    const assets = [
      {
        path: 'index.html',
        sha256: 'a'.repeat(64),
        byteLength: pageBytes,
        contentType: 'text/html'
      },
      { path: 'app.js', sha256: 'b'.repeat(64), byteLength: 2, contentType: 'text/javascript' }
    ]
    return {
      manifest: { ...MANIFEST, buildId: computeMobileWebBundleId(assets), totalBytes: 0, assets },
      assets: new Map(assets.map((asset) => [asset.path, new Uint8Array(asset.byteLength)])),
      reused: [],
      totalBytes: 0,
      elapsedMs: 1
    }
  }
  const CACHED = bundle(4)
  const UPDATE = {
    ...bundle(8),
    assets: new Map([['index.html', new Uint8Array(8)]]),
    reused: ['app.js']
  }

  async function cachedStore() {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    await store.commitGeneration(await store.stageGeneration(HOST, CACHED))
    return { fileSystem, store }
  }

  function runFor(store: GenerationStore, downloads = new Set<AbortController>()) {
    const { events, send } = collect()
    const done = download({
      client: CLIENT,
      store,
      hostKey: HOST,
      flow: 3,
      runtime: {
        createStore: () => store,
        mintSessionId: () => 's',
        claimSpareSessionId: async () => null,
        now: () => 0,
        setForegroundTimer: () => () => {}
      },
      startedAt: 0,
      downloads,
      send
    })
    return done.then(() => events)
  }

  it('stages from the offered snapshot without reopening its manifest after fetch', async () => {
    const { fileSystem, store } = await cachedStore()
    doubles.fetch = async () => {
      fileSystem.failReadsAt(`${HOST}/generations/${CACHED.manifest.buildId}/manifest.json`)
      return UPDATE
    }

    const events = await runFor(store)

    expect(events.some((event) => event.type === 'activated')).toBe(true)
    expect(fileSystem.bytes(`${HOST}/generations/${UPDATE.manifest.buildId}/app.js`)).toEqual(
      new Uint8Array(2)
    )
  })

  it('finishes when a faster download commits the same build before its fetch returns', async () => {
    const { fileSystem, store } = await cachedStore()
    let releaseSlow = (): void => {}
    const slowReady = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    let enteredSlow = (): void => {}
    const fetching = new Promise<void>((resolve) => {
      enteredSlow = resolve
    })
    let calls = 0
    doubles.fetch = async () => {
      calls += 1
      if (calls === 1) {
        enteredSlow()
        await slowReady
      }
      return UPDATE
    }
    const slow = runFor(store)
    await fetching
    const fast = await runFor(store)
    releaseSlow()
    const events = await slow

    expect(fast.some((event) => event.type === 'activated')).toBe(true)
    expect(events.some((event) => event.type === 'activated')).toBe(true)
    expect(fileSystem.bytes(`${HOST}/generations/${UPDATE.manifest.buildId}/app.js`)).toEqual(
      new Uint8Array(2)
    )
  })
})
