import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as GitRunner from '../../git/runner'
import { gitExecFileAsync, gitExecFileAsyncBuffer } from '../../git/runner'
import { serveRepositoriesOverTestSsh } from '../__mocks__/plugin-git-ssh-remote-fixture'
import { fetchPluginMarketplace } from './plugin-marketplace-fetch'

vi.mock('../../git/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof GitRunner>()
  return { ...actual, gitExecFileAsyncBuffer: vi.fn(actual.gitExecFileAsyncBuffer) }
})

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('reads only the catalog index, prefers orca-catalog.json, and ignores plugin size limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-marketplace-fetch-'))
  roots.push(root)
  const repository = join(root, 'catalog')
  const git = async (args: string[]) => (await gitExecFileAsync(args, { cwd: repository })).stdout
  const entry = {
    id: 'samples.demo',
    source: { kind: 'git', url: 'https://example.com/demo.git', ref: 'v1' },
    categories: []
  }
  const catalog = (name: string, plugins: unknown[]) =>
    JSON.stringify({ name, owner: 'samples', plugins })
  // More files than one plugin may hold: the catalog download has its own limits.
  await mkdir(join(repository, 'packs'), { recursive: true })
  for (let index = 0; index <= 2_000; index += 1) {
    await writeFile(join(repository, 'packs', `${index}.txt`), String(index))
  }
  await writeFile(join(repository, 'orca-marketplace.json'), catalog('Old', [entry]))
  await writeFile(
    join(repository, 'orca-catalog.json'),
    JSON.stringify({ catalogVersion: 2, name: 'New', owner: 'samples', plugins: [] })
  )
  await git(['init', '--quiet'])
  // Git's detached auto-maintenance after commit can still be writing .git during teardown.
  await git(['config', 'maintenance.auto', 'false'])
  await git(['add', '--all'])
  await git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'c'])
  await git(['tag', 'catalog'])
  await serveRepositoriesOverTestSsh(root, { '/catalog.git': repository })

  const fetched = await fetchPluginMarketplace({
    id: 'a'.repeat(32),
    source: { kind: 'git', url: 'ssh://git@catalog.example.invalid/catalog.git', ref: 'catalog' },
    addedAt: 0
  })

  expect(fetched.marketplace.name).toBe('New')
  expect(fetched.marketplaceCommit).toBe((await git(['rev-parse', 'HEAD'])).trim())
})

function png(width: number, height: number, padding = 0): Buffer {
  const header = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(header)
  header.write('IHDR', 12, 'ascii')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  header.set([8, 6, 0, 0, 0], 24)
  return Buffer.concat([header, Buffer.alloc(padding)])
}

it('reads every monorepo plugin image in shared Git calls and refuses oversized files unread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-marketplace-images-'))
  roots.push(root)
  const repository = join(root, 'catalog')
  const url = 'ssh://git@catalog.example.invalid/catalog.git'
  const git = async (args: string[]) => (await gitExecFileAsync(args, { cwd: repository })).stdout
  const plugins = ['alpha', 'beta', 'gamma']
  for (const [index, name] of plugins.entries()) {
    await mkdir(join(repository, 'plugins', name, 'images'), { recursive: true })
    const manifest = {
      name,
      cover: { path: 'images/cover.png', alt: name },
      screenshots: [{ path: 'images/missing.png', alt: 'gone' }]
    }
    await writeFile(join(repository, 'plugins', name, 'orca-plugin.json'), JSON.stringify(manifest))
    // gamma's cover is over the 1 MB cover limit.
    await writeFile(
      join(repository, 'plugins', name, 'images', 'cover.png'),
      png(1600 + index, 1000, name === 'gamma' ? 1024 * 1024 : 0)
    )
  }
  const release = {
    version: '1.0.0',
    commit: 'c'.repeat(40),
    contentHash: 'f'.repeat(64),
    execution: 'data',
    minimumOrca: '1.4.245'
  }
  await writeFile(
    join(repository, 'orca-catalog.json'),
    JSON.stringify({
      catalogVersion: 2,
      name: 'Images',
      owner: 'samples',
      plugins: plugins.map((name) => ({
        id: `samples.${name}`,
        source: { kind: 'git', url, ref: 'main', path: `plugins/${name}` },
        categories: [],
        releases: [release]
      }))
    })
  )
  await git(['init', '--quiet'])
  await git(['config', 'maintenance.auto', 'false'])
  await git(['add', '--all'])
  await git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'c'])
  await git(['tag', 'catalog'])
  await serveRepositoriesOverTestSsh(root, { '/catalog.git': repository })
  vi.mocked(gitExecFileAsyncBuffer).mockClear()

  const fetched = await fetchPluginMarketplace({
    id: 'b'.repeat(32),
    source: { kind: 'git', url, ref: 'catalog' },
    addedAt: 0
  })

  expect(
    fetched.marketplace.plugins.map((plugin) => plugin.releases?.[0]?.images?.cover?.width ?? null)
  ).toEqual([1600, 1601, null])
  expect(fetched.images?.map((image) => image.byteLength)).toEqual([33, 33])
  // Index listing and read, then one listing and one batch read per dependency round.
  expect(vi.mocked(gitExecFileAsyncBuffer).mock.calls.map(([args]) => args[0])).toEqual([
    'ls-tree',
    'cat-file',
    'ls-tree',
    'cat-file',
    'ls-tree',
    'cat-file'
  ])
})

it.each([7, 70])(
  'bounds speculative image reads for a %i MB catalog and preserves the verified-image budget',
  async (count) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-marketplace-budget-'))
    roots.push(root)
    const repository = join(root, 'catalog')
    const git = async (args: string[]) => (await gitExecFileAsync(args, { cwd: repository })).stdout
    await mkdir(join(repository, 'images'), { recursive: true })
    const plugins: unknown[] = []
    for (let index = 0; index < count; index += 1) {
      const path = `images/${index}.png`
      const bytes = png(1600 + index, 1000, 1024 * 1024 - 33)
      await writeFile(join(repository, path), bytes)
      plugins.push({
        id: `samples.image${index}`,
        source: { kind: 'git', url: 'https://example.com/plugin.git', ref: 'main' },
        categories: [],
        releases: [
          {
            version: '1.0.0',
            commit: 'c'.repeat(40),
            contentHash: 'f'.repeat(64),
            execution: 'data',
            minimumOrca: '1.4.245',
            images: {
              cover: {
                path,
                alt: 'cover',
                width: 1600 + index,
                height: 1000,
                sha256:
                  index === 0 ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex')
              }
            }
          }
        ]
      })
    }
    await writeFile(
      join(repository, 'orca-catalog.json'),
      JSON.stringify({
        catalogVersion: 2,
        name: 'Budget',
        owner: 'samples',
        plugins
      })
    )
    await git(['init', '--quiet'])
    await git(['config', 'maintenance.auto', 'false'])
    await git(['add', '--all'])
    await git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'c'])
    await git(['tag', 'catalog'])
    await serveRepositoriesOverTestSsh(root, { '/catalog.git': repository })
    vi.mocked(gitExecFileAsyncBuffer).mockClear()

    const fetched = await fetchPluginMarketplace({
      id: 'd'.repeat(32),
      source: { kind: 'git', url: 'ssh://git@catalog.example.invalid/catalog.git', ref: 'catalog' },
      addedAt: 0
    })

    const kept = fetched.marketplace.plugins.flatMap((plugin) => {
      const cover = plugin.releases?.[0]?.images?.cover
      return cover ? [cover.width] : []
    })
    expect(kept).toEqual(
      Array.from({ length: Math.min(count - 1, 64) }, (_, index) => 1601 + index)
    )
    expect(fetched.images?.reduce((sum, image) => sum + image.byteLength, 0)).toBe(
      Math.min(count - 1, 64) * 1024 * 1024
    )
    const batches = vi
      .mocked(gitExecFileAsyncBuffer)
      .mock.calls.filter(([args]) => args[0] === 'cat-file' && args[1] === '--batch')
    expect(batches.map(([, options]) => options?.stdin?.trim().split('\n').length)).toEqual(
      count <= 64 ? [count] : Array.from({ length: 65 }, () => 1)
    )
  }
)
