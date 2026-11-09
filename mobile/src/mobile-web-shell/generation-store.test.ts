import { describe, expect, it } from 'vitest'
import { createGenerationStore, MAX_CACHED_HOSTS } from './generation-store'
import { deriveHostCacheKey } from './host-cache-key'
import type { MobileWebBundleFetchResult } from '../transport/web-bundle/mobile-web-bundle-fetch'
import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import {
  createFakeGenerationFileSystem as createFakeFileSystem,
  FAKE_GENERATION_ROOT
} from './generation-file-system-fake'

const ROOT = FAKE_GENERATION_ROOT
const HOST = deriveHostCacheKey('host-a')

function buildResult(options: {
  buildId?: string
  assets?: readonly { path: string; byteLength: number }[]
  bytes?: ReadonlyMap<string, Uint8Array>
}): MobileWebBundleFetchResult {
  const listed = options.assets ?? [
    { path: 'index.html', byteLength: 4 },
    { path: 'assets/app.js', byteLength: 2 }
  ]
  const assets = listed.map((asset, index) => ({
    path: asset.path,
    sha256: String(index).repeat(64).slice(0, 64),
    byteLength: asset.byteLength,
    contentType: 'text/html; charset=utf-8'
  }))
  const totalBytes = assets.reduce((sum, asset) => sum + asset.byteLength, 0)
  return {
    manifest: {
      schemaVersion: 1,
      buildId: options.buildId ?? computeMobileWebBundleId(assets),
      minCompatibleRuntimeProtocolVersion: 2,
      runtimeProtocolVersion: 2,
      entrypoint: 'index.html',
      totalBytes,
      assets
    },
    assets:
      options.bytes ??
      new Map(assets.map((asset) => [asset.path, new Uint8Array(asset.byteLength).fill(7)])),
    reused: [],
    totalBytes,
    elapsedMs: 1
  }
}

// Derive ids from assets so the cached manifest passes its digest check.
const BUILD = buildResult({}).manifest.buildId
const SECOND = { assets: [{ path: 'index.html', byteLength: 8 }] }
const SECOND_BUILD = buildResult(SECOND).manifest.buildId

async function activate(
  store: ReturnType<typeof createGenerationStore>,
  hostKey: string,
  result = buildResult({})
): Promise<void> {
  await store.commitGeneration(await store.stageGeneration(hostKey, result))
}

function hostKeys(count: number): string[] {
  return Array.from({ length: count }, (_, index) => deriveHostCacheKey(`host-${index}`))
}

describe('generation store', () => {
  it('refuses an asset that is missing or the wrong length, leaving no generation', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    const missing = buildResult({ bytes: new Map([['index.html', new Uint8Array(4)]]) })
    const short = buildResult({
      bytes: new Map([
        ['index.html', new Uint8Array(4)],
        ['assets/app.js', new Uint8Array(1)]
      ])
    })

    await expect(store.stageGeneration(HOST, missing)).rejects.toThrow('assets/app.js is absent')
    await expect(store.stageGeneration(HOST, short)).rejects.toThrow("not the manifest's 2")
    expect(fs.paths()).toEqual([])
    expect(await store.readActiveGeneration(HOST)).toBeNull()
  })

  it('drops the staged tree when a write fails', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    fs.failWritesAt(`${HOST}/tmp/${BUILD}/assets/app.js`)

    await expect(store.stageGeneration(HOST, buildResult({}))).rejects.toThrow('disk-full')

    expect(fs.paths().some((path) => path.includes(`tmp/${BUILD}`))).toBe(false)
    expect(await store.readActiveGeneration(HOST)).toBeNull()
  })

  it('leaves no generation and no tmp for any host when a download is interrupted', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    const other = deriveHostCacheKey('host-b')
    // The manifest is written last, so a download cut off mid-stage leaves assets without one.
    fs.seed(`${HOST}/tmp/${BUILD}/index.html`, { kind: 'file', bytes: new Uint8Array(4) })
    fs.seed(`${other}/tmp/${BUILD}/index.html`, { kind: 'file', bytes: new Uint8Array(4) })

    expect(await store.readActiveGeneration(HOST)).toBeNull()
    expect(await store.readActiveGeneration(other)).toBeNull()
    expect(fs.paths().some((path) => path.includes('/tmp'))).toBe(false)
  })

  it('reads two generations as no activation and drops the host tree', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    await activate(store, HOST)
    fs.seed(`${HOST}/generations/${'c'.repeat(64)}/manifest.json`, {
      kind: 'file',
      bytes: new TextEncoder().encode('{}')
    })

    expect(await store.readActiveGeneration(HOST)).toBeNull()
    expect(fs.paths().some((path) => path.startsWith(HOST))).toBe(false)
  })

  it('reads an unparseable or mismatched manifest as no activation and drops the host tree', async () => {
    for (const body of [
      'not json',
      JSON.stringify({ ...buildResult({}).manifest, buildId: 'd'.repeat(64) })
    ]) {
      const fs = createFakeFileSystem()
      const store = createGenerationStore({ fileSystem: fs })
      await activate(store, HOST)
      fs.seed(`${HOST}/generations/${BUILD}/manifest.json`, {
        kind: 'file',
        bytes: new TextEncoder().encode(body)
      })

      expect(await store.readActiveGeneration(HOST)).toBeNull()
      expect(fs.paths().some((path) => path.startsWith(HOST))).toBe(false)
    }
  })

  it('evicts the least recently activated host past the ceiling', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    const hosts = hostKeys(MAX_CACHED_HOSTS + 1)

    for (const host of hosts) {
      await activate(store, host)
    }

    expect(await store.readActiveGeneration(hosts[0])).toBeNull()
    expect(fs.paths().some((path) => path.startsWith(hosts[0]))).toBe(false)
    for (const host of hosts.slice(1)) {
      expect((await store.readActiveGeneration(host))?.buildId).toBe(BUILD)
    }
    expect(fs.text('hosts.json')).toBe(JSON.stringify(hosts.slice(1)))
  })

  it('evicts a host with no index entry before the least recently activated one', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    const [oldest, ...rest] = hostKeys(MAX_CACHED_HOSTS - 1)
    const orphan = deriveHostCacheKey('orphan')
    for (const host of [oldest, ...rest]) {
      await activate(store, host)
    }
    await activate(store, orphan)
    const order = [oldest, ...rest]
    fs.seed('hosts.json', { kind: 'file', bytes: new TextEncoder().encode(JSON.stringify(order)) })

    await activate(store, deriveHostCacheKey('one-too-many'))

    expect(fs.paths().some((path) => path.startsWith(orphan))).toBe(false)
    expect((await store.readActiveGeneration(oldest))?.buildId).toBe(BUILD)
  })

  it('never counts or evicts a host that is only mid-download', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    const hosts = hostKeys(MAX_CACHED_HOSTS)
    const oldest = hosts[0]
    const downloading = deriveHostCacheKey('downloading')
    for (const host of hosts) {
      await activate(store, host)
    }
    const staged = await store.stageGeneration(downloading, buildResult({}))

    await activate(store, deriveHostCacheKey('one-too-many'))

    // Count activations only; eviction must leave staged downloads intact.
    expect(fs.paths().some((path) => path.startsWith(oldest))).toBe(false)
    expect(fs.text(`${staged.directory.slice(ROOT.length + 1)}/manifest.json`)).not.toBeNull()
    await store.commitGeneration(staged)
    expect((await store.readActiveGeneration(downloading))?.buildId).toBe(BUILD)
  })

  it('serializes two stage calls for one host and build', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    // Give one build id conflicting asset lists to expose interleaved writes into the same staging directory.
    const staging = `${HOST}/tmp/${BUILD}`
    const earlier = buildResult({
      buildId: BUILD,
      assets: [{ path: 'assets/earlier.js', byteLength: 2 }]
    })
    const later = buildResult({
      buildId: BUILD,
      assets: [{ path: 'assets/later.js', byteLength: 3 }]
    })

    const [first, second] = await Promise.all([
      store.stageGeneration(HOST, earlier),
      store.stageGeneration(HOST, later)
    ])

    expect(first.directory).toBe(second.directory)
    expect(fs.writes).toEqual([
      `${staging}/assets/earlier.js`,
      `${staging}/manifest.json`,
      `${staging}/assets/later.js`,
      `${staging}/manifest.json`
    ])
    expect(fs.paths().filter((path) => path.startsWith(`${staging}/assets/`))).toEqual([
      `${staging}/assets/later.js`
    ])
  })

  it('refuses a path that escapes the staged tree, and a host key that is not one', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    const escapes = [
      '../outside.js',
      'assets/../../outside.js',
      '/etc/passwd',
      'assets//app.js',
      'manifest.json',
      'Manifest.JSON'
    ]

    for (const path of escapes) {
      const result = buildResult({ assets: [{ path, byteLength: 1 }] })
      await expect(store.stageGeneration(HOST, result)).rejects.toThrow('refuses to stage')
    }
    await expect(store.stageGeneration('host-a', buildResult({}))).rejects.toThrow(
      'not a host cache key'
    )
    expect(fs.paths()).toEqual([])
  })

  it('refuses a rename that did not carry the tree, as Android below API 26 can', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    fs.loseContentsOnMove()

    const staged = await store.stageGeneration(HOST, buildResult({}))
    await expect(store.commitGeneration(staged)).rejects.toThrow('did not carry its manifest')

    expect(await store.readActiveGeneration(HOST)).toBeNull()
    expect(fs.paths().some((path) => path.includes('generations/'))).toBe(false)
  })

  it('keeps the host tree when the manifest read fails, and drops it when it is missing', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    const manifest = `${HOST}/generations/${BUILD}/manifest.json`
    await activate(store, HOST)
    const before = fs.paths().filter((path) => !path.endsWith('/tmp'))

    fs.failReadsAt(manifest)
    expect(await store.readActiveGeneration(HOST)).toBeNull()
    expect(fs.paths()).toEqual(before)

    fs.failReadsAt(null)
    await fs.delete(`${ROOT}/${manifest}`)
    expect(await store.readActiveGeneration(HOST)).toBeNull()
    expect(fs.paths().some((path) => path.startsWith(HOST))).toBe(false)
  })

  it('replaces an entry named for the build id that is not a readable generation', async () => {
    const build = BUILD
    // Model a crash between rename and the post-rename manifest check.
    for (const seeded of [
      { kind: 'directory' },
      { kind: 'file', bytes: new Uint8Array(1) }
    ] as const) {
      const fs = createFakeFileSystem()
      const store = createGenerationStore({ fileSystem: fs })
      fs.seed(`${HOST}/generations/${build}`, seeded)

      await activate(store, HOST)

      expect((await store.readActiveGeneration(HOST))?.buildId).toBe(build)
      expect(fs.text(`${HOST}/generations/${build}/index.html`)).not.toBeNull()
    }
  })

  it('refuses a handle whose staged tree is gone without touching the activation', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    await activate(store, HOST)

    const staged = await store.stageGeneration(HOST, buildResult(SECOND))
    await store.abortStagedGeneration(staged)

    await expect(store.commitGeneration(staged)).rejects.toThrow('no longer on disk')
    expect((await store.readActiveGeneration(HOST))?.buildId).toBe(BUILD)
  })

  it('refuses a staged handle it did not issue', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    await activate(store, HOST)
    const before = fs.paths()
    const forged = {
      hostKey: HOST,
      buildId: SECOND_BUILD,
      directory: `${ROOT}/${HOST}/generations/${BUILD}`,
      manifest: buildResult({}).manifest
    }

    await expect(store.commitGeneration(forged)).rejects.toThrow('did not issue')
    await expect(store.abortStagedGeneration(forged)).rejects.toThrow('did not issue')
    expect(fs.paths()).toEqual(before)
    expect((await store.readActiveGeneration(HOST))?.buildId).toBe(BUILD)
  })
})

describe('reusable assets for the next download', () => {
  const NEXT = buildResult({
    assets: [
      { path: 'index.html', byteLength: 8 },
      { path: 'assets/app-2.js', byteLength: 2 }
    ]
  })
  const NEXT_BUILD = NEXT.manifest.buildId
  const [PAGE, SCRIPT] = NEXT.manifest.assets
  const DOWNLOADED = new Map([['index.html', new Uint8Array(8).fill(9)]])
  const LEFT_TO_STAGE = { ...NEXT, assets: DOWNLOADED, reused: ['assets/app-2.js'] }

  it.each([HOST, deriveHostCacheKey('second-host')])(
    'matches cached assets by content for %s',
    async (opened) => {
      const fs = createFakeFileSystem()
      const store = createGenerationStore({ fileSystem: fs })
      expect((await store.openReusableAssets(HOST)).has(SCRIPT!)).toBe(false)
      await activate(store, HOST)

      const reusable = await store.openReusableAssets(opened)

      expect(reusable.has(SCRIPT!)).toBe(true)
      expect(reusable.has(PAGE!)).toBe(false)
      expect(reusable.has({ ...SCRIPT!, sha256: 'f'.repeat(64) })).toBe(false)
      expect(await reusable.check(SCRIPT!)).toBe(true)
      fs.seed(`${HOST}/generations/${BUILD}/assets/app.js`, {
        kind: 'file',
        bytes: new Uint8Array(1)
      })
      expect(await reusable.check(SCRIPT!)).toBe(false)
    }
  )

  it('copies the reused assets beside the downloaded ones and commits the whole build', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    await activate(store, HOST)

    await activate(store, HOST, LEFT_TO_STAGE)

    const generation = `${HOST}/generations/${NEXT_BUILD}`
    expect(fs.bytes(`${generation}/index.html`)).toEqual(new Uint8Array(8).fill(9))
    expect(fs.bytes(`${generation}/assets/app-2.js`)).toEqual(new Uint8Array(2).fill(7))
    expect((await store.readActiveGeneration(HOST))?.buildId).toBe(NEXT_BUILD)
  })

  it('refuses to stage a reused asset the active generation no longer holds', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    await activate(store, HOST)
    fs.failReadsAt(`${HOST}/generations/${BUILD}/assets/app.js`)

    await expect(store.stageGeneration(HOST, LEFT_TO_STAGE)).rejects.toThrow('unreadable')
    await store.deleteHostCache(HOST)
    fs.failReadsAt(null)
    await expect(store.stageGeneration(HOST, LEFT_TO_STAGE)).rejects.toThrow(
      'no longer holds the reused asset assets/app-2.js'
    )
    expect(fs.paths().some((path) => path.includes(`tmp/${NEXT_BUILD}`))).toBe(false)
  })
})

// Commit deletes the old build first, so it must not run under a page still loading that build's chunks.
describe('an update staged behind a live page', () => {
  it('stays staged while a page reads the old build, and the next read after it commits', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    await activate(store, HOST)
    const release = store.holdGeneration(HOST)
    store.deferCommit(await store.stageGeneration(HOST, buildResult(SECOND)))

    expect((await store.readActiveGeneration(HOST))?.buildId).toBe(BUILD)
    expect(await fs.fileExists(`${ROOT}/${HOST}/generations/${BUILD}/index.html`)).toBe(true)

    release()
    expect((await store.readActiveGeneration(HOST))?.buildId).toBe(SECOND_BUILD)
    expect(await fs.fileExists(`${ROOT}/${HOST}/generations/${BUILD}/index.html`)).toBe(false)
  })

  it('lets a page that waited on another page fetch the build itself when that page gives up', async () => {
    const store = createGenerationStore({ fileSystem: createFakeFileSystem() })
    const first = await store.claimUpdate(HOST, SECOND_BUILD)
    const second = store.claimUpdate(HOST, SECOND_BUILD)

    first?.()

    expect(await second).not.toBeNull()
  })

  it('commits at the next launch when the app ends while the page still reads the old build', async () => {
    const fs = createFakeFileSystem()
    const first = createGenerationStore({ fileSystem: fs })
    await activate(first, HOST)
    first.holdGeneration(HOST)
    first.deferCommit(await first.stageGeneration(HOST, buildResult(SECOND)))

    const relaunched = createGenerationStore({ fileSystem: fs })

    expect((await relaunched.readActiveGeneration(HOST))?.buildId).toBe(SECOND_BUILD)
    expect(await fs.fileExists(`${ROOT}/${HOST}/generations/${SECOND_BUILD}/index.html`)).toBe(true)
  })

  it('lets a reader of a host’s build go before a commit or a removal deletes it', async () => {
    const fs = createFakeFileSystem()
    const onDisk: boolean[] = []
    let reading = BUILD
    const store = createGenerationStore({
      fileSystem: fs,
      beforeHostFilesDeleted: async (hostKey) => {
        onDisk.push(await fs.fileExists(`${ROOT}/${hostKey}/generations/${reading}/manifest.json`))
      }
    })
    await activate(store, HOST)
    onDisk.length = 0
    await activate(store, HOST, buildResult(SECOND))
    reading = SECOND_BUILD
    await store.deleteHostCache(HOST)
    expect(onDisk).toEqual([true, true])
  })
})
