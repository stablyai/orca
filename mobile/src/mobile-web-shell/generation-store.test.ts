import { describe, expect, it } from 'vitest'
import { createGenerationStore } from './generation-store'
import { deriveHostCacheKey } from './host-cache-key'
import type { MobileWebBundleFetchResult } from '../transport/mobile-web-bundle-fetch'
import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import {
  createFakeGenerationFileSystem as createFakeFileSystem,
  FAKE_GENERATION_ROOT,
  type FakeGenerationFileSystem as FakeFileSystem
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
  it('stages and commits exactly the manifest, with the manifest written last', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })

    await activate(store, HOST)

    const build = BUILD
    expect(fs.paths()).toEqual([
      HOST,
      `${HOST}/generations`,
      `${HOST}/generations/${build}`,
      `${HOST}/generations/${build}/assets`,
      `${HOST}/generations/${build}/assets/app.js`,
      `${HOST}/generations/${build}/index.html`,
      `${HOST}/generations/${build}/manifest.json`,
      `${HOST}/tmp`
    ])
    const staged = fs.writes.filter((path) => path.includes('/tmp/'))
    expect(staged.at(-1)).toBe(`${HOST}/tmp/${build}/manifest.json`)
    expect(staged).toHaveLength(3)
  })

  it('reads back the activation it committed', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })

    await activate(store, HOST)
    const active = await store.readActiveGeneration(HOST)

    expect(active?.buildId).toBe(BUILD)
    expect(active?.directory).toBe(`${ROOT}/${HOST}/generations/${BUILD}`)
    expect(active?.manifest.entrypoint).toBe('index.html')
    expect(await store.readActiveGeneration(deriveHostCacheKey('never-opened'))).toBeNull()
  })

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

    await store.stageGeneration(HOST, buildResult({}))
    await store.stageGeneration(other, buildResult({}))
    await store.sweepStagedGenerations()

    expect(fs.paths().some((path) => path.includes('/tmp'))).toBe(false)
    expect(await store.readActiveGeneration(HOST)).toBeNull()
    expect(await store.readActiveGeneration(other)).toBeNull()
  })

  it('treats a second commit of the same build as a no-op', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })

    await activate(store, HOST)
    const before = fs.paths()
    const staged = await store.stageGeneration(HOST, buildResult({}))
    const active = await store.commitGeneration(staged)

    expect(active.buildId).toBe(BUILD)
    expect(fs.paths()).toEqual(before)
  })

  it('replaces the previous generation when the build id changes', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })

    await activate(store, HOST)
    await activate(store, HOST, buildResult(SECOND))

    expect(fs.paths().some((path) => path.includes(BUILD))).toBe(false)
    expect((await store.readActiveGeneration(HOST))?.buildId).toBe(SECOND_BUILD)
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

  it('keeps every host it has activated, however many are paired', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    const hosts = hostKeys(12)

    for (const host of hosts) {
      await activate(store, host)
    }

    for (const host of hosts) {
      expect((await store.readActiveGeneration(host))?.buildId).toBe(BUILD)
    }
  })

  it('sweeps the trees of hosts that are no longer paired and keeps the paired ones', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    const [paired, unpaired, downloading] = hostKeys(3)
    await activate(store, paired)
    await activate(store, unpaired)
    await store.stageGeneration(downloading, buildResult({}))

    await store.deleteUnpairedHostCaches(async () => new Set([paired]))

    expect((await store.readActiveGeneration(paired))?.buildId).toBe(BUILD)
    expect(fs.paths().filter((path) => !path.startsWith(paired))).toEqual([])
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

  it('drops residue from an earlier attempt instead of staging over it', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    const staging = `${HOST}/tmp/${BUILD}`
    fs.seed(`${staging}/assets/orphan.js`, { kind: 'file', bytes: new Uint8Array(1) })

    await store.stageGeneration(HOST, buildResult({}))

    expect(fs.paths().some((path) => path.endsWith('orphan.js'))).toBe(false)
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

  it('deletes one host tree without touching another', async () => {
    const fs = createFakeFileSystem()
    const other = deriveHostCacheKey('host-b')
    const store = createGenerationStore({ fileSystem: fs })
    await activate(store, HOST)
    await activate(store, other)

    await store.deleteHostCache(HOST)

    expect(await store.readActiveGeneration(HOST)).toBeNull()
    expect((await store.readActiveGeneration(other))?.buildId).toBe(BUILD)
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
    const before = fs.paths()

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

  it('drops an aborted staging without touching the activation', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    await activate(store, HOST)

    const staged = await store.stageGeneration(HOST, buildResult(SECOND))
    await store.abortStagedGeneration(staged)

    expect(fs.paths().some((path) => path.includes(SECOND_BUILD))).toBe(false)
    expect((await store.readActiveGeneration(HOST))?.buildId).toBe(BUILD)
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

  it('ignores a directory under the cache root that is not a host key', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    fs.seed('not-a-host-key/stray.txt', { kind: 'file', bytes: new Uint8Array(1) })
    const hosts = ['a', 'b', 'c', 'd'].map((name) => deriveHostCacheKey(name))

    for (const host of hosts) {
      await activate(store, host)
    }
    await store.sweepStagedGenerations()
    await store.deleteUnpairedHostCaches(async () => new Set(hosts))

    expect(fs.paths()).toContain('not-a-host-key/stray.txt')
    for (const host of hosts) {
      expect((await store.readActiveGeneration(host))?.buildId).toBe(BUILD)
    }
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

  it('matches cached assets by content, and checks them without reading them', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    expect((await store.openReusableAssets(HOST)).has(SCRIPT!)).toBe(false)
    await activate(store, HOST)

    const reusable = await store.openReusableAssets(HOST)

    expect(reusable.has(SCRIPT!)).toBe(true)
    expect(reusable.has(PAGE!)).toBe(false)
    expect(await reusable.check(SCRIPT!)).toBe(true)
    fs.seed(`${HOST}/generations/${BUILD}/assets/app.js`, {
      kind: 'file',
      bytes: new Uint8Array(1)
    })
    expect(await reusable.check(SCRIPT!)).toBe(false)
  })

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

// Older builds could leave manifest-next.json after an interrupted rewrite; this reader must ignore it.
describe('a pending manifest left by an older build', () => {
  const MANIFEST_PATH = `${HOST}/generations/${BUILD}/manifest.json`
  const NEXT_PATH = `${HOST}/generations/${BUILD}/manifest-next.json`

  function seedPending(fs: FakeFileSystem): void {
    const body = JSON.stringify({ ...buildResult({}).manifest, routes: [] })
    fs.seed(NEXT_PATH, { kind: 'file', bytes: new TextEncoder().encode(body) })
  }

  it('reads the manifest beside it and leaves it inert', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    await activate(store, HOST)
    const stored = fs.text(MANIFEST_PATH)
    seedPending(fs)

    expect((await store.readActiveGeneration(HOST))?.buildId).toBe(BUILD)

    expect(fs.text(MANIFEST_PATH)).toBe(stored)
  })

  it('drops the host tree for a redownload when it is the only manifest left', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    await activate(store, HOST)
    seedPending(fs)
    await fs.delete(`${ROOT}/${MANIFEST_PATH}`)

    expect(await store.readActiveGeneration(HOST)).toBeNull()

    expect(fs.paths().some((path) => path.startsWith(`${HOST}/generations`))).toBe(false)
  })
})
