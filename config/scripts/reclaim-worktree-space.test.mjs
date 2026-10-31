import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { reclaimWorktreeSpace } from './reclaim-worktree-space.mjs'
import { runProcess } from '@orca/process-host'
import { retainViteCache, VITE_CACHE_USAGE_DIRECTORY } from './vite-cache-activity.mjs'

const roots = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-storage-maintenance-'))
  roots.push(root)
  const execute = vi.fn(async () => ({ code: 0, timedOut: false }))
  return { commonDirectory: root, repoRoot: root, execute }
}

it('previews historical test caches, Electron cleanup, and Vite caches', async () => {
  const options = { ...(await fixture()), testsStopped: true }
  await reclaimWorktreeSpace(options)
  expect(options.execute).toHaveBeenCalledTimes(7)
  expect(options.execute.mock.calls.flatMap(([spec]) => spec.args)).not.toContain('--apply')
})

it('forwards apply and repository selection to all cleanup operations', async () => {
  const options = { ...(await fixture()), apply: true, testsStopped: true }
  await reclaimWorktreeSpace(options)
  expect(options.execute).toHaveBeenCalledTimes(7)
  for (const [spec] of options.execute.mock.calls) {
    expect(spec.args).toContain('--apply')
    expect(spec.args).toContain(options.repoRoot)
    expect(spec.terminationBarrier).toBe(true)
  }
  const cache = options.execute.mock.calls.at(-1)[0]
  expect(cache.args).toContain('--tests-stopped')
  expect(cache.args).toContain('--import')
  for (const [spec] of options.execute.mock.calls.slice(0, -1)) {
    expect(spec.args).not.toContain('--tests-stopped')
  }
})

it('includes generated and historical test cache cleanup in automatic invocations without the stopped-test override', async () => {
  const options = {
    ...(await fixture()),
    automatic: true,
    apply: true,
    testsStopped: true,
    excludeWorktree: '/dev-worktree'
  }
  await reclaimWorktreeSpace(options)
  expect(options.execute).toHaveBeenCalledTimes(7)
  const args = options.execute.mock.calls.flatMap(([spec]) => spec.args)
  expect(args.join(' ')).toContain('reclaim-release-test-caches')
  expect(args.join(' ')).toContain('reclaim-worktree-generated-files')
  expect(args).not.toContain('--tests-stopped')
  for (const [spec] of options.execute.mock.calls.slice(0, -1)) {
    expect(spec.args).toEqual(
      expect.arrayContaining(['--exclude-worktree', options.excludeWorktree])
    )
  }
})

it('routes independent age overrides only to their cleanup operation', async () => {
  const options = {
    ...(await fixture()),
    releaseCacheMinAgeDays: 7,
    generatedMinAgeDays: 3,
    testsStopped: true
  }
  await reclaimWorktreeSpace(options)
  expect(options.execute.mock.calls.at(-1)[0].args).toEqual(
    expect.arrayContaining(['--min-age-days', '7'])
  )
  for (const [spec] of options.execute.mock.calls.slice(0, -1)) {
    expect(spec.args).not.toContain('--min-age-days')
  }
  for (const [spec] of options.execute.mock.calls) {
    if (spec.args.some((arg) => arg.endsWith('reclaim-worktree-generated-files.mjs'))) {
      expect(spec.args).toEqual(expect.arrayContaining(['--generated-min-age-days', '3']))
    } else {
      expect(spec.args).not.toContain('--generated-min-age-days')
    }
  }
})

it.each([
  ['releaseCacheMinAgeDays', '--release-cache-min-age-days'],
  ['generatedMinAgeDays', '--generated-min-age-days']
])('rejects invalid %s before starting cleanup', async (key, flag) => {
  const options = { ...(await fixture()), [key]: -1 }
  await expect(reclaimWorktreeSpace(options)).rejects.toThrow(flag)
  expect(options.execute).not.toHaveBeenCalled()
})

it("runs the CLI outside the repository and retains an active worktree's historical caches until tests are stopped", async () => {
  const options = await fixture()
  const init = await runProcess({
    program: 'git',
    args: ['init', '--quiet'],
    cwd: options.repoRoot,
    timeoutMs: 10_000,
    terminationBarrier: true
  })
  expect(init.code).toBe(0)
  const commit = 'd'.repeat(40)
  const cache = join(
    options.repoRoot,
    'tests',
    'e2e',
    '.cross-version-checkouts',
    'old',
    `${commit}-format-4`
  )
  await mkdir(cache, { recursive: true })
  const marker = join(cache, 'checkout-stamp.json')
  await writeFile(marker, JSON.stringify({ commit, format: 4 }))
  await utimes(cache, new Date(0), new Date(0))
  const viteCache = join(options.repoRoot, '.cache', 'vite')
  const releaseCache = await retainViteCache(viteCache)
  await releaseCache()
  await mkdir(join(viteCache, 'renderer', 'deps'), { recursive: true })
  const dependency = join(viteCache, 'renderer', 'deps', 'react.js')
  await writeFile(dependency, 'export const cached = true')
  await utimes(join(viteCache, VITE_CACHE_USAGE_DIRECTORY), new Date(0), new Date(0))
  const run = (flags = []) =>
    runProcess({
      program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
      args: [
        resolve(import.meta.dirname, 'reclaim-worktree-space.mjs'),
        '--repo',
        options.repoRoot,
        ...flags
      ],
      cwd: tmpdir(),
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 20_000,
      terminationBarrier: true
    })
  const preview = await run(['--tests-stopped'])
  expect(preview.code, preview.stderr).toBe(0)
  expect(preview.stdout).toContain('Would remove 1 cache(s)')
  expect(await readFile(marker, 'utf8')).toContain(commit)
  expect(await readFile(dependency, 'utf8')).toContain('cached')
  const safe = await run(['--apply'])
  expect(safe.code, safe.stderr).toBe(0)
  expect(safe.stdout).toContain('retained caches in 1 active worktree(s)')
  expect(await readFile(marker, 'utf8')).toContain(commit)
  expect(safe.stdout).toContain('Removed 1 Vite cache(s)')
  await expect(readFile(dependency)).rejects.toMatchObject({ code: 'ENOENT' })
  const applied = await run(['--apply', '--tests-stopped'])
  expect(applied.code, applied.stderr).toBe(0)
  expect(applied.stdout).toContain('Removed 1 cache(s)')
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects competing sweeps and releases the lock after a failed operation', async () => {
  const options = { ...(await fixture()), apply: true, testsStopped: true }
  let release
  const blocked = new Promise((resolve) => {
    release = resolve
  })
  let entered
  const ready = new Promise((resolve) => {
    entered = resolve
  })
  options.execute.mockImplementation(async () => {
    entered()
    await blocked
    return { code: 1, timedOut: false }
  })
  const first = reclaimWorktreeSpace(options)
  const rejected = expect(first).rejects.toThrow('failed')
  await ready
  await expect(reclaimWorktreeSpace(options)).rejects.toThrow('already running')
  release()
  await rejected
  options.execute.mockResolvedValue({ code: 0, timedOut: false })
  await reclaimWorktreeSpace(options)
  expect(options.execute).toHaveBeenCalledTimes(8)
})

it('preserves the cleanup failure and reports a concurrent lock release failure separately', async () => {
  const options = await fixture()
  const failure = new Error('original cleanup failure')
  options.execute.mockRejectedValue(failure)
  const release = vi.fn().mockRejectedValue(new Error('lock release failure'))
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(
      reclaimWorktreeSpace({ ...options, acquireLock: async () => release })
    ).rejects.toBe(failure)
    expect(release).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith('Failed to release cleanup lock: lock release failure')
  } finally {
    report.mockRestore()
  }
})

it('fails if cleanup succeeds but the repository lock cannot be released', async () => {
  const options = { ...(await fixture()), testsStopped: true }
  const failure = new Error('lock release failure')
  const release = vi.fn().mockRejectedValue(failure)
  await expect(reclaimWorktreeSpace({ ...options, acquireLock: async () => release })).rejects.toBe(
    failure
  )
  expect(options.execute).toHaveBeenCalledTimes(7)
})
