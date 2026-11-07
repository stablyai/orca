import { describe, expect, it, vi } from 'vitest'
import type { MobileWebShellSessionEvent } from './mobile-web-shell-session-contract'

const doubles = vi.hoisted(() => ({
  manifest: (): Promise<unknown> => Promise.reject(new Error('no manifest staged')),
  fetch: (): Promise<unknown> => Promise.reject(new Error('no fetch staged'))
}))

vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: '' } }))
// The runner's deadlines live in the runtime module, whose foreground timer reads React Native's AppState.
vi.mock('./foreground-timer', () => ({ setForegroundTimer: () => () => {} }))
vi.mock('../transport/rpc-operation', () => ({
  defineRpcOperation: (definition: unknown) => definition,
  runRpcOperation: () => doubles.manifest()
}))
vi.mock('../transport/web-bundle/mobile-web-bundle-fetch', () => ({
  fetchMobileWebBundle: () => doubles.fetch()
}))

import type { RpcClient } from '../transport/rpc-client'
import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import type { MobileWebBundleFetchResult } from '../transport/web-bundle/mobile-web-bundle-fetch'
import { createGenerationStore, type GenerationStore } from './generation-store'
import { createFakeGenerationFileSystem } from './generation-file-system-fake'
import { deriveHostCacheKey } from './host-cache-key'
import { download, stageUpdate } from './mobile-web-shell-session-effects'

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
        now: () => 0,
        setForegroundTimer: () => () => {}
      },
      startedAt: 0,
      downloads,
      send
    })
    return done.then(() => events)
  }

  it('downloads nothing when another page on the host already staged that build', async () => {
    const store = createGenerationStore({ fileSystem: createFakeGenerationFileSystem() })
    const NEXT = bundle(16)
    store.deferCommit(await store.stageGeneration(HOST, NEXT))
    let fetches = 0
    doubles.fetch = () => {
      fetches += 1
      return Promise.resolve(NEXT)
    }
    const { events, send } = collect()
    await stageUpdate({
      client: CLIENT,
      store,
      hostKey: HOST,
      flow: 3,
      downloads: new Set(),
      opened: { manifest: { ...NEXT.manifest, pageVersion: 1 }, chunkBytes: 4 },
      send
    })
    expect(fetches).toBe(0)
    expect(events).toEqual([])
  })

  it('writes no staging bytes when canceled while its staging waits in the store queue', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    const NEXT = bundle(16)
    const BLOCKER = deriveHostCacheKey('host-b')
    let enterBlocker = (): void => {}
    const blockerEntered = new Promise<void>((resolve) => {
      enterBlocker = resolve
    })
    let releaseBlocker = (): void => {}
    const blockerReleased = new Promise<void>((resolve) => {
      releaseBlocker = resolve
    })
    const list = fileSystem.list.bind(fileSystem)
    fileSystem.list = async (uri) => {
      if (uri.includes(`/${BLOCKER}/`)) {
        enterBlocker()
        await blockerReleased
      }
      return list(uri)
    }
    const writes: string[] = []
    const writeBytes = fileSystem.writeBytes.bind(fileSystem)
    fileSystem.writeBytes = async (uri, bytes) => {
      writes.push(uri)
      await writeBytes(uri, bytes)
    }
    let blocker: Promise<unknown> = Promise.resolve()
    doubles.fetch = async () => {
      blocker = store.readActiveGeneration(BLOCKER)
      await blockerEntered
      return NEXT
    }
    let markQueued = (): void => {}
    const stageQueued = new Promise<void>((resolve) => {
      markQueued = resolve
    })
    const downloads = new Set<AbortController>()
    const run = runFor(
      {
        ...store,
        stageGeneration: (...args) => {
          const staged = store.stageGeneration(...args)
          markQueued()
          return staged
        }
      },
      downloads
    )

    await stageQueued
    downloads.forEach((controller) => controller.abort())
    releaseBlocker()
    await Promise.all([run, blocker])

    expect(writes.filter((uri) => uri.includes(`/tmp/${NEXT.manifest.buildId}/`))).toEqual([])
  })

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
