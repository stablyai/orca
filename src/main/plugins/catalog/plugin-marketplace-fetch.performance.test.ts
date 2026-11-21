import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { PLUGIN_CATALOG_FILENAME } from '../../../shared/plugins/catalog/plugin-catalog'
import * as gitExecFile from '../../git/command-runner/git-exec-file'
import { fetchPluginMarketplace } from './plugin-marketplace-fetch'

// Perf contract (#43444): a catalog whose images passed the read cap fell back to one Git call per image.

// The worker-thread spawner's entry is a build output, so Windows unit runs spawn Git directly, as macOS and Linux do.
vi.mock(
  '../../worker-thread-child-process/worker-thread-child-process',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    canSpawnOnWorkerThread: () => false,
    whenSpawnWorkerReady: async () => false
  })
)

// The clone itself is outside the contract; reads run against a local repository at its commit.
vi.mock('../installation/plugin-git-repository', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readPluginGitCommit: async (
    input: { url: string },
    read: (repository: string, commit: string) => Promise<unknown>
  ) => {
    const commit = (await git(input.url, ['rev-parse', 'HEAD'])).trim()
    return { commit, value: await read(input.url, commit) }
  }
}))

const run = promisify(execFile)
const PLUGINS = 10
const SCREENSHOTS_PER_PLUGIN = 6
const SCREENSHOT_BYTES = 1400 * 1024
// The last plugin's small screenshots take retained bytes past 64 MiB in one more round, so this needs the retained cap's one-round slack.
const SMALL_SCREENSHOT_BYTES = 200 * 1024
const roots: string[] = []

async function git(cwd: string, args: string[]): Promise<string> {
  return (await run('git', args, { cwd, maxBuffer: 1024 * 1024 })).stdout
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** A 1280×800 PNG header padded to `size` bytes, made distinct by `seed`. */
function screenshot(seed: number, size: number): Buffer {
  const png = Buffer.alloc(size)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0)
  png.writeUInt32BE(13, 8)
  png.write('IHDR', 12, 'ascii')
  png.writeUInt32BE(1280, 16)
  png.writeUInt32BE(800, 20)
  png.writeUInt32BE(size - 45, 33)
  png.write('IDAT', 37, 'ascii')
  png.writeUInt32BE(seed, 41)
  return png
}

/** A catalog repository listing `PLUGINS` plugins with six screenshots each, more than the image budget. */
async function catalogRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-catalog-images-'))
  roots.push(root)
  const plugins: unknown[] = []
  for (let plugin = 0; plugin < PLUGINS; plugin++) {
    const screenshots: unknown[] = []
    for (let shot = 0; shot < SCREENSHOTS_PER_PLUGIN; shot++) {
      const size = plugin === PLUGINS - 1 ? SMALL_SCREENSHOT_BYTES : SCREENSHOT_BYTES
      const bytes = screenshot(plugin * SCREENSHOTS_PER_PLUGIN + shot, size)
      const path = `images/p${plugin}/s${shot}.png`
      await mkdir(join(root, 'images', `p${plugin}`), { recursive: true })
      await writeFile(join(root, path), bytes)
      screenshots.push({
        path,
        alt: 'Screenshot',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        width: 1280,
        height: 800
      })
    }
    plugins.push({
      id: `community.plugin-${plugin}`,
      source: { kind: 'git', url: `https://github.com/community/plugin-${plugin}.git`, ref: 'v1' },
      releases: [
        {
          version: '1.0.0',
          commit: 'c'.repeat(40),
          contentHash: 'f'.repeat(64),
          execution: 'data',
          minimumOrca: '1.4.0',
          types: ['interface-language'],
          images: { screenshots }
        }
      ]
    })
  }
  const catalog = { catalogVersion: 2, name: 'Community', owner: 'community', plugins }
  await writeFile(join(root, PLUGIN_CATALOG_FILENAME), JSON.stringify(catalog))
  await git(root, ['init', '--quiet', '--object-format=sha1'])
  await git(root, ['add', '--all'])
  await git(root, [
    '-c',
    'user.name=Orca Test',
    '-c',
    'user.email=orca-test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'catalog'
  ])
  return root
}

it('a catalog over the image budget reads its images in a few batched Git calls', async () => {
  const repository = await catalogRepository()
  const calls = vi.spyOn(gitExecFile, 'gitExecFileAsyncBuffer')

  const result = await fetchPluginMarketplace({
    id: 'community',
    source: { kind: 'git', url: repository, ref: 'main' },
    addedAt: 0
  })

  // The 64 MiB budget keeps 46 large and 5 small screenshots: the index, then one listing and three reads of up to 32 MiB.
  expect({
    images: result.images?.length,
    git: calls.mock.calls.map(([args]) => args[0])
  }).toEqual({
    images: 51,
    git: ['ls-tree', 'cat-file', 'ls-tree', 'cat-file', 'cat-file', 'cat-file']
  })
})
