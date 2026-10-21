import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProcess } from '@orca/process-host'
import { createServer } from 'vite'
import { afterEach, expect, it, vi } from 'vitest'
import { createViteCacheRetentionPlugin } from '../build-plugins/vite-cache-retention'
import { reclaimViteCaches } from './reclaim-vite-caches.mjs'
import {
  retainViteCache,
  VITE_CACHE_USAGE_DIRECTORY,
  withViteCacheLock
} from './vite-cache-activity.mjs'

const roots = []
const nowMs = Date.now()
const dayMs = 86_400_000

afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function age(cacheRoot, days = 31) {
  const time = new Date(nowMs - days * dayMs)
  await utimes(join(cacheRoot, VITE_CACHE_USAGE_DIRECTORY), time, time)
}

async function fixture(days = 31) {
  const root = await mkdtemp(join(tmpdir(), 'orca-vite-cache-'))
  roots.push(root)
  const worktree = join(root, 'worktree')
  const cacheRoot = join(worktree, '.cache', 'vite')
  const release = await retainViteCache(cacheRoot)
  await release()
  const files = ['renderer', 'web'].map((target) => join(cacheRoot, target, 'deps', 'react.js'))
  for (const file of files) {
    await mkdir(resolve(file, '..'), { recursive: true })
    await writeFile(file, 'export const cached = true')
  }
  await age(cacheRoot, days)
  return {
    root,
    worktree,
    cacheRoot,
    files,
    worktrees: [worktree, worktree],
    nowMs,
    report: vi.fn()
  }
}

it('previews and removes old owned caches for both build targets', async () => {
  const options = await fixture()
  expect(await reclaimViteCaches(options)).toMatchObject({ entries: 1 })
  for (const file of options.files) {
    expect(await readFile(file, 'utf8')).toContain('cached')
  }
  expect(await reclaimViteCaches({ ...options, apply: true })).toMatchObject({ entries: 1 })
  for (const file of options.files) {
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  }
})

it('retains a recently used cache even when its dependency outputs are old', async () => {
  const options = await fixture(1)
  for (const file of options.files) {
    await utimes(file, new Date(0), new Date(0))
  }
  expect(await reclaimViteCaches({ ...options, apply: true })).toMatchObject({ entries: 0 })
})

it('retains every live owner and refreshes last use when a server closes', async () => {
  const options = await fixture()
  const first = await retainViteCache(options.cacheRoot)
  const second = await retainViteCache(options.cacheRoot)
  await age(options.cacheRoot)
  expect(await reclaimViteCaches({ ...options, apply: true })).toMatchObject({ entries: 0 })
  await first()
  await age(options.cacheRoot)
  expect(await reclaimViteCaches({ ...options, apply: true })).toMatchObject({ entries: 0 })
  await second()
  expect(await reclaimViteCaches({ ...options, apply: true })).toMatchObject({ entries: 0 })
  await age(options.cacheRoot)
  expect(await reclaimViteCaches({ ...options, apply: true })).toMatchObject({ entries: 1 })
})

it.each([false, true])(
  'reclaims exited owners only on this host (foreign: %s)',
  async (foreign) => {
    const options = await fixture()
    const moduleUrl = pathToFileURL(resolve(import.meta.dirname, 'vite-cache-activity.mjs')).href
    const child = await runProcess({
      program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
      args: [
        '--input-type=module',
        '-e',
        `import { retainViteCache } from ${JSON.stringify(moduleUrl)}; await retainViteCache(${JSON.stringify(options.cacheRoot)});`
      ],
      env: foreign
        ? { ...process.env, WSL_DISTRO_NAME: `${process.env.WSL_DISTRO_NAME ?? ''}-other` }
        : process.env,
      timeoutMs: 10_000,
      terminationBarrier: true
    })
    expect(child.code, child.stderr).toBe(0)
    await age(options.cacheRoot)
    expect(await reclaimViteCaches({ ...options, apply: true })).toMatchObject({
      entries: foreign ? 0 : 1
    })
  }
)

it.each(['foreign-host', 'corrupt', 'permission-denied'])(
  'retains unverifiable ownership: %s',
  async (kind) => {
    const options = await fixture()
    const release = await retainViteCache(options.cacheRoot)
    const owners = join(options.cacheRoot, VITE_CACHE_USAGE_DIRECTORY)
    const [name] = await readdir(owners)
    const owner = join(owners, name)
    if (kind === 'foreign-host') {
      await rename(owner, join(owners, name.replace(/^[\da-f]{64}/, '0'.repeat(64))))
    } else if (kind === 'corrupt') {
      await writeFile(owner, '{')
    } else {
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' })
      })
    }
    try {
      await age(options.cacheRoot)
      expect(await reclaimViteCaches({ ...options, apply: true })).toMatchObject({ entries: 0 })
    } finally {
      vi.restoreAllMocks()
      await release()
    }
  }
)

it('retains untracked caches and the worktree being launched', async () => {
  const options = await fixture()
  expect(
    await reclaimViteCaches({ ...options, apply: true, excludeWorktree: options.worktree })
  ).toMatchObject({ entries: 0 })
  await rm(join(options.cacheRoot, VITE_CACHE_USAGE_DIRECTORY), { recursive: true })
  expect(await reclaimViteCaches({ ...options, apply: true })).toMatchObject({ entries: 0 })
})

it.each(['.cache', 'vite'])('does not follow a %s directory link during cleanup', async (part) => {
  const options = await fixture()
  const source = part === '.cache' ? join(options.worktree, '.cache') : options.cacheRoot
  const target = join(options.root, 'outside')
  await rename(source, target)
  await symlink(target, source, 'junction')
  expect(await reclaimViteCaches({ ...options, apply: true })).toMatchObject({ entries: 0 })
  expect(await readdir(target)).not.toEqual([])
})

it('does not sweep while cache initialization holds the maintenance lock', async () => {
  const options = await fixture()
  await withViteCacheLock(options.cacheRoot, async () => {
    expect(await reclaimViteCaches({ ...options, apply: true })).toMatchObject({
      entries: 0,
      protected: 1
    })
  })
})

it('tracks a real Vite server until shutdown has completed', async () => {
  const options = await fixture()
  const server = await createServer({
    configFile: false,
    root: options.worktree,
    cacheDir: join(options.cacheRoot, 'renderer'),
    logLevel: 'silent',
    server: { middlewareMode: true, watch: null, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [createViteCacheRetentionPlugin(options.cacheRoot)]
  })
  try {
    await age(options.cacheRoot)
    expect(await reclaimViteCaches({ ...options, apply: true })).toMatchObject({ entries: 0 })
  } finally {
    await server.close()
  }
  expect(await readdir(join(options.cacheRoot, VITE_CACHE_USAGE_DIRECTORY))).toEqual([])
  expect(await reclaimViteCaches({ ...options, apply: true })).toMatchObject({ entries: 0 })
  await age(options.cacheRoot)
  expect(await reclaimViteCaches({ ...options, apply: true })).toMatchObject({ entries: 1 })
})
