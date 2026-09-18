import { describe, expect, it } from 'vitest'
import { createGenerationStore, MAX_CACHED_HOSTS } from './generation-store'
import { deriveHostCacheKey } from './host-cache-key'
import type {
  createExpoGenerationFileSystem,
  GenerationFileSystem
} from './generation-store-file-system'
import type { MobileWebBundleFetchResult } from '../transport/mobile-web-bundle-fetch'

// The adapter is deliberately untested at runtime — it would need a device filesystem — so this is
// the check that it still answers the port the store is written against.
type AdapterIsPort =
  ReturnType<typeof createExpoGenerationFileSystem> extends GenerationFileSystem ? true : false
const adapterSatisfiesPort: AdapterIsPort = true

const ROOT = 'file:///cache/mobile-web'
const HOST = deriveHostCacheKey('host-a')

type FakeNode = { kind: 'directory' } | { kind: 'file'; bytes: Uint8Array }

type FakeFileSystem = GenerationFileSystem & {
  readonly writes: string[]
  paths(): readonly string[]
  seed(path: string, node: FakeNode): void
  failWritesAt(path: string | null): void
  loseContentsOnMove(): void
  text(path: string): string | null
}

function createFakeFileSystem(): FakeFileSystem {
  const nodes = new Map<string, FakeNode>()
  const writes: string[] = []
  let failAt: string | null = null
  let moveKeepsContents = true
  const uri = (path: string): string => `${ROOT}/${path}`
  const parentOf = (target: string): string => target.slice(0, target.lastIndexOf('/'))

  const makeDirectory = (target: string): void => {
    for (let at = target; at.startsWith(ROOT); at = parentOf(at)) {
      nodes.set(at, { kind: 'directory' })
    }
  }
  const write = (target: string, bytes: Uint8Array): void => {
    if (failAt !== null && target === uri(failAt)) {
      throw new Error('simulated disk-full write')
    }
    makeDirectory(parentOf(target))
    nodes.set(target, { kind: 'file', bytes })
    writes.push(target.slice(ROOT.length + 1))
  }

  return {
    rootUri: ROOT,
    writes,
    paths: () =>
      [...nodes.keys()]
        .filter((key) => key !== ROOT)
        .map((key) => key.slice(ROOT.length + 1))
        .sort(),
    seed: (path, node) => {
      makeDirectory(parentOf(uri(path)))
      nodes.set(uri(path), node)
    },
    failWritesAt: (path) => {
      failAt = path
    },
    loseContentsOnMove: () => {
      moveKeepsContents = false
    },
    text: (path) => {
      const node = nodes.get(uri(path))
      return node?.kind === 'file' ? new TextDecoder().decode(node.bytes) : null
    },
    async list(target) {
      if (nodes.get(target)?.kind !== 'directory') {
        return []
      }
      return [...nodes.entries()]
        .filter(
          ([key]) => key.startsWith(`${target}/`) && !key.slice(target.length + 1).includes('/')
        )
        .map(([key, node]) => ({
          name: key.slice(target.length + 1),
          isDirectory: node.kind === 'directory'
        }))
    },
    async createDirectory(target) {
      makeDirectory(target)
    },
    async writeBytes(target, bytes) {
      write(target, bytes)
    },
    async writeText(target, value) {
      write(target, new TextEncoder().encode(value))
    },
    async readText(target) {
      const node = nodes.get(target)
      return node?.kind === 'file' ? new TextDecoder().decode(node.bytes) : null
    },
    async fileExists(target) {
      return nodes.get(target)?.kind === 'file'
    },
    async delete(target) {
      for (const key of Array.from(nodes.keys())) {
        if (key === target || key.startsWith(`${target}/`)) {
          nodes.delete(key)
        }
      }
    },
    async moveDirectory(fromUri, toUri) {
      if (nodes.has(toUri)) {
        throw new Error(`fake filesystem refuses to move onto ${toUri}`)
      }
      for (const [key, node] of Array.from(nodes.entries())) {
        if (key === fromUri || key.startsWith(`${fromUri}/`)) {
          nodes.delete(key)
          if (moveKeepsContents || key === fromUri) {
            nodes.set(toUri + key.slice(fromUri.length), node)
          }
        }
      }
    }
  }
}

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
      buildId: options.buildId ?? 'a'.repeat(64),
      entrypoint: 'index.html',
      totalBytes,
      assets
    },
    assets:
      options.bytes ??
      new Map(assets.map((asset) => [asset.path, new Uint8Array(asset.byteLength).fill(7)])),
    totalBytes,
    elapsedMs: 1
  }
}

async function activate(
  store: ReturnType<typeof createGenerationStore>,
  hostKey: string,
  result = buildResult({})
): Promise<void> {
  await store.commitGeneration(await store.stageGeneration(hostKey, result))
}

describe('generation store', () => {
  it('stages and commits exactly the manifest, with the manifest written last', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs, now: () => 10 })

    await activate(store, HOST)

    const build = 'a'.repeat(64)
    expect(fs.paths()).toEqual([
      HOST,
      `${HOST}/generations`,
      `${HOST}/generations/${build}`,
      `${HOST}/generations/${build}/assets`,
      `${HOST}/generations/${build}/assets/app.js`,
      `${HOST}/generations/${build}/index.html`,
      `${HOST}/generations/${build}/manifest.json`,
      `${HOST}/tmp`,
      'hosts.json'
    ])
    const staged = fs.writes.filter((path) => path.includes('/tmp/'))
    expect(staged.at(-1)).toBe(`${HOST}/tmp/${build}/manifest.json`)
    expect(staged).toHaveLength(3)
    expect(fs.text('hosts.json')).toBe(JSON.stringify({ [HOST]: 10 }))
  })

  it('reads back the activation it committed', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })

    await activate(store, HOST)
    const active = await store.readActiveGeneration(HOST)

    expect(active?.buildId).toBe('a'.repeat(64))
    expect(active?.directory).toBe(`${ROOT}/${HOST}/generations/${'a'.repeat(64)}`)
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
    fs.failWritesAt(`${HOST}/tmp/${'a'.repeat(64)}/assets/app.js`)

    await expect(store.stageGeneration(HOST, buildResult({}))).rejects.toThrow('disk-full')

    expect(fs.paths().some((path) => path.includes(`tmp/${'a'.repeat(64)}`))).toBe(false)
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
    const store = createGenerationStore({ fileSystem: fs, now: () => 10 })

    await activate(store, HOST)
    const before = fs.paths()
    const staged = await store.stageGeneration(HOST, buildResult({}))
    const active = await store.commitGeneration(staged)

    expect(active.buildId).toBe('a'.repeat(64))
    expect(fs.paths()).toEqual(before)
  })

  it('replaces the previous generation when the build id changes', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })

    await activate(store, HOST)
    await activate(store, HOST, buildResult({ buildId: 'b'.repeat(64) }))

    expect(fs.paths().some((path) => path.includes('a'.repeat(64)))).toBe(false)
    expect((await store.readActiveGeneration(HOST))?.buildId).toBe('b'.repeat(64))
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
      fs.seed(`${HOST}/generations/${'a'.repeat(64)}/manifest.json`, {
        kind: 'file',
        bytes: new TextEncoder().encode(body)
      })

      expect(await store.readActiveGeneration(HOST)).toBeNull()
      expect(fs.paths().some((path) => path.startsWith(HOST))).toBe(false)
    }
  })

  it('evicts the least recently activated host past the ceiling', async () => {
    const fs = createFakeFileSystem()
    let clock = 0
    const store = createGenerationStore({ fileSystem: fs, now: () => (clock += 1) })
    const hosts = ['a', 'b', 'c', 'd', 'e'].map((name) => deriveHostCacheKey(name))

    for (const host of hosts) {
      await activate(store, host)
    }

    expect(await store.readActiveGeneration(hosts[0])).toBeNull()
    expect(fs.paths().some((path) => path.startsWith(hosts[0]))).toBe(false)
    for (const host of hosts.slice(1)) {
      expect((await store.readActiveGeneration(host))?.buildId).toBe('a'.repeat(64))
    }
    expect(Object.keys(JSON.parse(fs.text('hosts.json') ?? '{}'))).toHaveLength(MAX_CACHED_HOSTS)
  })

  it('evicts a host with no index entry before the least recently activated one', async () => {
    const fs = createFakeFileSystem()
    let clock = 0
    const store = createGenerationStore({ fileSystem: fs, now: () => (clock += 1) })
    const oldest = deriveHostCacheKey('a')
    const orphan = deriveHostCacheKey('orphan')
    for (const name of ['a', 'b', 'c']) {
      await activate(store, deriveHostCacheKey(name))
    }
    // Activated last, so recency alone would keep it; its index entry is what goes missing.
    await activate(store, orphan)
    const index: Record<string, number> = JSON.parse(fs.text('hosts.json') ?? '{}')
    delete index[orphan]
    fs.seed('hosts.json', { kind: 'file', bytes: new TextEncoder().encode(JSON.stringify(index)) })

    await activate(store, deriveHostCacheKey('d'))

    expect(fs.paths().some((path) => path.startsWith(orphan))).toBe(false)
    expect((await store.readActiveGeneration(oldest))?.buildId).toBe('a'.repeat(64))
  })

  it('serializes two stage calls for one host and build', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    // One build id cannot really carry two asset lists; differing ones are what make an interleaved
    // pair visible, because unserialized both trees land in the one staged directory.
    const staging = `${HOST}/tmp/${'a'.repeat(64)}`
    const earlier = buildResult({ assets: [{ path: 'assets/earlier.js', byteLength: 2 }] })
    const later = buildResult({ assets: [{ path: 'assets/later.js', byteLength: 3 }] })

    const [first, second] = await Promise.all([
      store.stageGeneration(HOST, earlier),
      store.stageGeneration(HOST, later)
    ])

    expect(first.directory).toBe(second.directory)
    // Each staging is a contiguous run ending in its manifest; interleaved they would alternate.
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
    const staging = `${HOST}/tmp/${'a'.repeat(64)}`
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
    expect((await store.readActiveGeneration(other))?.buildId).toBe('a'.repeat(64))
    expect(Object.keys(JSON.parse(fs.text('hosts.json') ?? '{}'))).toEqual([other])
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

  it('drops an aborted staging without touching the activation', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    await activate(store, HOST)

    const staged = await store.stageGeneration(HOST, buildResult({ buildId: 'b'.repeat(64) }))
    await store.abortStagedGeneration(staged)

    expect(fs.paths().some((path) => path.includes('b'.repeat(64)))).toBe(false)
    expect((await store.readActiveGeneration(HOST))?.buildId).toBe('a'.repeat(64))
  })

  it('keeps the host it just activated when the clock jumps backward', async () => {
    const fs = createFakeFileSystem()
    const times = [100, 200, 300, 400, 1]
    let tick = 0
    const store = createGenerationStore({ fileSystem: fs, now: () => times[tick++] ?? 0 })
    const hosts = ['a', 'b', 'c', 'd', 'e'].map((name) => deriveHostCacheKey(name))

    for (const host of hosts) {
      await activate(store, host)
    }

    expect((await store.readActiveGeneration(hosts[4]))?.directory).toBe(
      `${ROOT}/${hosts[4]}/generations/${'a'.repeat(64)}`
    )
    expect(await store.readActiveGeneration(hosts[0])).toBeNull()
    for (const host of hosts.slice(1)) {
      expect((await store.readActiveGeneration(host))?.buildId).toBe('a'.repeat(64))
    }
  })

  it('prunes an index entry whose host tree is gone', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs, now: () => 10 })
    const stale = deriveHostCacheKey('uninstalled')
    fs.seed('hosts.json', {
      kind: 'file',
      bytes: new TextEncoder().encode(JSON.stringify({ [stale]: 5 }))
    })

    await activate(store, HOST)

    expect(fs.text('hosts.json')).toBe(JSON.stringify({ [HOST]: 10 }))
  })

  it('returns the activation even when the recency index cannot be written', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    fs.failWritesAt('hosts.json')

    const staged = await store.stageGeneration(HOST, buildResult({}))
    const active = await store.commitGeneration(staged)

    expect(active.buildId).toBe('a'.repeat(64))
    expect((await store.readActiveGeneration(HOST))?.buildId).toBe('a'.repeat(64))
    expect(fs.text('hosts.json')).toBeNull()
  })

  it('refuses a handle whose staged tree is gone without touching the activation', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    await activate(store, HOST)

    const staged = await store.stageGeneration(HOST, buildResult({ buildId: 'b'.repeat(64) }))
    await store.abortStagedGeneration(staged)

    await expect(store.commitGeneration(staged)).rejects.toThrow('no longer on disk')
    expect((await store.readActiveGeneration(HOST))?.buildId).toBe('a'.repeat(64))
  })

  it('keeps the adapter aligned with the port', () => {
    expect(adapterSatisfiesPort).toBe(true)
  })
})
