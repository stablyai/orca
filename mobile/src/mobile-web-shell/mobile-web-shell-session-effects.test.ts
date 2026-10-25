import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileWebShellSessionEvent } from './mobile-web-shell-session-contract'

/** Each place a read of the host's generation can fail, and the cause it reports. */
const doubles = vi.hoisted(() => ({
  manifest: (): Promise<unknown> => Promise.reject(new Error('no manifest staged')),
  fetch: (): Promise<unknown> => Promise.reject(new Error('no fetch staged'))
}))

vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: '' } }))
vi.mock('../transport/rpc-operation', () => ({
  defineRpcOperation: (definition: unknown) => definition,
  runRpcOperation: () => doubles.manifest()
}))
vi.mock('../transport/mobile-web-bundle-fetch', () => ({
  fetchMobileWebBundle: () => doubles.fetch()
}))

import { MobileWebBundleFetchError } from '../transport/mobile-web-bundle-fetch-refusal'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { RpcClient } from '../transport/rpc-client'
import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import type { MobileWebBundleFetchResult } from '../transport/mobile-web-bundle-fetch'
import { createGenerationStore, type GenerationStore } from './generation-store'
import { createFakeGenerationFileSystem } from './generation-file-system-fake'
import { deriveHostCacheKey } from './host-cache-key'
import { download, openCache, readManifest } from './mobile-web-shell-session-effects'

// The mocked operations never touch the client; they only need one to exist.
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

function storeThat(fail: 'stage' | 'commit' | null): GenerationStore {
  const reject = async (): Promise<never> => {
    throw new Error('simulated disk-full write')
  }
  const staged = { hostKey: 'k', buildId: MANIFEST.buildId, directory: 'd', manifest: MANIFEST }
  return {
    readActiveGeneration: async () => null,
    stageGeneration: fail === 'stage' ? reject : async () => staged,
    commitGeneration:
      fail === 'commit'
        ? reject
        : async () => ({ buildId: MANIFEST.buildId, directory: 'd', manifest: MANIFEST }),
    abortStagedGeneration: async () => undefined,
    openReusableAssets: async () => ({ has: () => false, check: async () => false }),
    sweepStagedGenerations: async () => undefined,
    deleteHostCache: async () => undefined,
    recordUpdateFailure: async () => undefined,
    readUpdateFailures: async () => [],
    forgetHostUpdateFailures: async () => undefined
  }
}

function collect(): {
  events: MobileWebShellSessionEvent[]
  send: (e: MobileWebShellSessionEvent) => void
} {
  const events: MobileWebShellSessionEvent[] = []
  return { events, send: (event) => events.push(event) }
}

async function downloadEvents(
  client: RpcClient | null,
  store: GenerationStore,
  downloads = new Set<AbortController>()
) {
  const { events, send } = collect()
  await download({
    client,
    store,
    hostKey: 'k',
    flow: 3,
    runtime: {
      createStore: () => store,
      mintSessionId: () => 's',
      now: () => 0,
      setTimer: () => () => {}
    },
    startedAt: 0,
    downloads,
    send
  })
  return events
}

async function runDownload(client: RpcClient | null, store: GenerationStore) {
  return (await downloadEvents(client, store)).filter((event) => event.type === 'download-failed')
}

describe('the manifest read', () => {
  beforeEach(() => {
    doubles.manifest = () => Promise.reject(new Error('no manifest staged'))
  })

  it('with no client reports no connection', async () => {
    const { events, send } = collect()
    await readManifest(null, 3, send)
    expect(events).toEqual([
      { type: 'download-failed', flow: 3, cause: { reason: 'no-connection', hostCode: null } }
    ])
  })

  it('cut off by the link reports the link', async () => {
    doubles.manifest = () => Promise.reject(markRpcDeliveryUnknown(new Error('socket closed')))
    const { events, send } = collect()
    await readManifest(CLIENT, 3, send)
    expect(events).toMatchObject([{ cause: { reason: 'connection-lost' } }])
  })

  it("refused by the host reports the host's code", async () => {
    doubles.manifest = () =>
      Promise.reject(new Error('invalid_argument: mobile_web_bundle_unavailable'))
    const { events, send } = collect()
    await readManifest(CLIENT, 3, send)
    expect(events).toMatchObject([
      { cause: { reason: 'host-refused', hostCode: 'mobile_web_bundle_unavailable' } }
    ])
  })
})

describe('the page version the floor reads', () => {
  it('is carried from the host manifest to the reducer', async () => {
    doubles.manifest = () => Promise.resolve({ manifest: { ...MANIFEST, pageVersion: 4 } })
    const { events, send } = collect()
    await readManifest(CLIENT, 3, send)
    expect(events).toMatchObject([{ type: 'manifest-read', manifest: { pageVersion: 4 } }])
  })

  it('is carried from the cached manifest to the generation judged against the host', async () => {
    const store: GenerationStore = {
      ...storeThat(null),
      readActiveGeneration: async () => ({
        buildId: MANIFEST.buildId,
        directory: 'd',
        manifest: { ...MANIFEST, pageVersion: 4, routes: [] }
      })
    }
    expect((await openCache(store, 'k'))?.compat.pageVersion).toBe(4)
  })
})

describe('the download', () => {
  beforeEach(() => {
    doubles.fetch = () =>
      Promise.resolve({
        manifest: MANIFEST,
        assets: new Map([['index.html', new Uint8Array(1)]]),
        totalBytes: 1,
        elapsedMs: 1
      })
  })

  it('with no client reports no connection', async () => {
    expect(await runDownload(null, storeThat(null))).toMatchObject([
      { cause: { reason: 'no-connection' } }
    ])
  })

  it('refusing the bytes reports the refusal', async () => {
    doubles.fetch = () =>
      Promise.reject(new MobileWebBundleFetchError('asset-checksum-mismatch', 'hashed x, not y'))
    expect(await runDownload(CLIENT, storeThat(null))).toMatchObject([
      { cause: { reason: 'asset-checksum-mismatch', hostCode: null } }
    ])
  })

  it('whose staging this phone could not write reports the cache write', async () => {
    expect(await runDownload(CLIENT, storeThat('stage'))).toMatchObject([
      { cause: { reason: 'cache-write-failed' } }
    ])
  })

  it('whose commit this phone could not write reports the cache write', async () => {
    expect(await runDownload(CLIENT, storeThat('commit'))).toMatchObject([
      { cause: { reason: 'cache-write-failed' } }
    ])
  })

  it('that lands whole reports no failure', async () => {
    const downloads = new Set<AbortController>()
    const fetch = doubles.fetch
    doubles.fetch = () => {
      expect(downloads.size).toBe(1)
      return fetch()
    }
    expect(await downloadEvents(CLIENT, storeThat(null), downloads)).toEqual([
      { type: 'download-staged', flow: 3 },
      {
        type: 'activated',
        flow: 3,
        generationDirectory: 'd',
        sessionId: 's',
        buildId: MANIFEST.buildId,
        totalBytes: 1,
        elapsedMs: 0
      }
    ])
    expect(downloads.size).toBe(0)
  })
})

/**
 * Against the real store: the copies a reused asset needs are made by the stage, on the store's
 * queue, so what other mounts do to the staging tree mid-download cannot take them away.
 */
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
  // The page changed; the script is left to the stage to copy.
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

  function runFor(store: GenerationStore) {
    const { events, send } = collect()
    const done = download({
      client: CLIENT,
      store,
      hostKey: HOST,
      flow: 3,
      runtime: {
        createStore: () => store,
        mintSessionId: () => 's',
        now: () => 0,
        setTimer: () => () => {}
      },
      startedAt: 0,
      downloads: new Set(),
      send
    })
    return done.then(() => events)
  }

  it('commits whole when another mount sweeps the staging trees mid-download', async () => {
    const { fileSystem, store } = await cachedStore()
    doubles.fetch = async () => {
      fileSystem.seed(`${HOST}/tmp/${UPDATE.manifest.buildId}/app.js`, {
        kind: 'file',
        bytes: new Uint8Array(1)
      })
      await store.sweepStagedGenerations()
      return UPDATE
    }

    const events = await runFor(store)

    expect(events.filter((event) => event.type === 'download-failed')).toEqual([])
    const active = await store.readActiveGeneration(HOST)
    expect(active?.buildId).toBe(UPDATE.manifest.buildId)
    expect(fileSystem.bytes(`${HOST}/generations/${UPDATE.manifest.buildId}/app.js`)).toEqual(
      new Uint8Array(2)
    )
  })

  it('commits once when two downloads of the same build finish together', async () => {
    const { fileSystem, store } = await cachedStore()
    doubles.fetch = async () => UPDATE
    const moveDirectory = fileSystem.moveDirectory.bind(fileSystem)
    const moves: [string, string][] = []
    fileSystem.moveDirectory = async (from, to) => {
      moves.push([from, to])
      await moveDirectory(from, to)
    }
    try {
      const [first, second] = await Promise.all([runFor(store), runFor(store)])
      const expected = [
        { type: 'download-staged', flow: 3 },
        {
          type: 'activated',
          flow: 3,
          generationDirectory: `/cache/mobile-web/${HOST}/generations/${UPDATE.manifest.buildId}`,
          sessionId: 's',
          buildId: UPDATE.manifest.buildId,
          totalBytes: UPDATE.manifest.totalBytes,
          elapsedMs: 0
        }
      ]
      expect(first).toEqual(expected)
      expect(second).toEqual(expected)
      expect(moves).toEqual([
        [
          `${fileSystem.rootUri}/${HOST}/tmp/${UPDATE.manifest.buildId}`,
          `${fileSystem.rootUri}/${HOST}/generations/${UPDATE.manifest.buildId}`
        ]
      ])
      expect(await store.readActiveGeneration(HOST)).toEqual({
        buildId: UPDATE.manifest.buildId,
        directory: `${fileSystem.rootUri}/${HOST}/generations/${UPDATE.manifest.buildId}`,
        manifest: UPDATE.manifest
      })
      expect(fileSystem.bytes(`${HOST}/generations/${UPDATE.manifest.buildId}/app.js`)).toEqual(
        new Uint8Array(2)
      )
    } finally {
      fileSystem.moveDirectory = moveDirectory
    }
  })
})
