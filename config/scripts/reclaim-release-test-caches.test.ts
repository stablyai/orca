import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { lock } from 'proper-lockfile'
import { reclaimReleaseTestCaches } from './reclaim-release-test-caches.mjs'
import { withReleaseSourceLease } from '../../tests/e2e/cross-version-wire/release-source-retention'
import { CHECKOUT_FORMAT } from '../../tests/e2e/cross-version-wire/release-checkout-publication'

const roots: string[] = []
const commit = 'c'.repeat(40)
const nowMs = Date.now()
const day = 24 * 60 * 60 * 1000

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-release-cache-cleanup-'))
  roots.push(root)
  const worktree = join(root, 'worktree')
  const commonDirectory = join(root, 'git')
  const cache = join(worktree, 'tests', 'e2e', '.cross-version-checkouts')
  const shared = join(commonDirectory, 'orca-cache', 'release-source')
  await mkdir(cache, { recursive: true })
  await mkdir(shared, { recursive: true })
  await writeFile(join(worktree, '.gitignore'), '.cross-version-checkouts/\n')
  const date = new Date(nowMs - 30 * day).toISOString()
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
  for (const args of [
    ['init', '-q'],
    ['add', '.gitignore'],
    ['commit', '-qm', 'base']
  ]) {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: worktree,
      env
    })
  }
  const targets = { commonDirectory, worktrees: [worktree, worktree] }
  const getProcessTable = () => ''
  return { root, worktree, cache, shared, targets, nowMs, getProcessTable, report: () => {} }
}

async function stamped(path: string, format = CHECKOUT_FORMAT, ageDays = 60) {
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'checkout-stamp.json'), JSON.stringify({ commit, format }))
  await writeFile(join(path, 'source.ts'), 'export const historical = true\n')
  const time = new Date(nowMs - ageDays * day)
  await utimes(path, time, time)
  return path
}

async function idle(worktree: string) {
  const time = new Date(nowMs - 30 * day)
  for (const entry of await readdir(worktree, { recursive: true })) {
    await utimes(join(worktree, entry), time, time)
  }
}

it('previews old stamped views and seeds without changing them', async () => {
  const options = await fixture()
  const local = await stamped(join(options.cache, 'v-old', `${commit}-format-4`), 4)
  const seed = await stamped(join(options.shared, `format-${CHECKOUT_FORMAT}`, commit))
  await idle(options.worktree)
  const result = await reclaimReleaseTestCaches(options)
  expect(result.entries).toBe(2)
  expect(result.logicalBytes).toBeGreaterThan(0)
  expect((await lstat(local)).isDirectory()).toBe(true)
  expect((await lstat(seed)).isDirectory()).toBe(true)
  await expect(lstat(`${local}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('removes old local checkouts only from idle worktrees unless tests are stopped', async () => {
  const options = await fixture()
  const local = await stamped(join(options.cache, 'v-old', `${commit}-format-4`), 4)
  await writeFile(join(options.worktree, 'edited.ts'), 'recent work')
  await idle(options.cache)
  const active = await reclaimReleaseTestCaches({ ...options, apply: true })
  expect(active).toMatchObject({ entries: 0, protected: 1 })
  expect((await lstat(local)).isDirectory()).toBe(true)

  await idle(options.worktree)
  const idleResult = await reclaimReleaseTestCaches({ ...options, apply: true })
  expect(idleResult).toMatchObject({ entries: 1, protected: 0 })
  await expect(lstat(local)).rejects.toMatchObject({ code: 'ENOENT' })

  const stopped = await stamped(join(options.cache, 'v-old', `${commit}-format-3`), 3)
  await writeFile(join(options.worktree, 'edited.ts'), 'more recent work')
  const override = await reclaimReleaseTestCaches({ ...options, apply: true, testsStopped: true })
  expect(override).toMatchObject({ entries: 1, protected: 0 })
  await expect(lstat(stopped)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('removes old generated trees and retains recent, future, malformed and mutable trees', async () => {
  const options = await fixture()
  const old = await stamped(join(options.cache, 'v-old', `${commit}-format-4`), 4)
  const seed = await stamped(join(options.shared, `format-${CHECKOUT_FORMAT}`, commit))
  const recent = await stamped(
    join(options.cache, 'v-new', `${commit}-format-${CHECKOUT_FORMAT}`),
    CHECKOUT_FORMAT,
    1
  )
  const future = await stamped(
    join(options.shared, `format-${CHECKOUT_FORMAT + 1}`, commit),
    CHECKOUT_FORMAT + 1
  )
  const malformed = await stamped(join(options.cache, 'invalid', `${commit}-format-4`), 5)
  const mutable = join(options.cache, 'working-tree', 'src', 'current.ts')
  await mkdir(join(mutable, '..'), { recursive: true })
  await writeFile(mutable, 'mutable working tree copy')
  const result = await reclaimReleaseTestCaches({ ...options, apply: true, testsStopped: true })
  expect(result.entries).toBe(2)
  for (const path of [old, seed]) {
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  }
  for (const path of [recent, future, malformed]) {
    expect((await lstat(path)).isDirectory()).toBe(true)
  }
  expect(await readFile(mutable, 'utf8')).toBe('mutable working tree copy')
})

it('does not follow cache, label, entry or shared-format symlinks', async () => {
  const options = await fixture()
  const outsideCache = join(options.root, 'outside-cache')
  const outsideLabel = join(options.root, 'outside-label')
  const outsideEntry = join(options.root, 'outside-entry', `${commit}-format-4`)
  const outsideFormat = join(options.root, 'outside-format')
  const sentinels = [
    await stamped(join(outsideCache, 'v-old', `${commit}-format-4`), 4),
    await stamped(join(outsideLabel, `${commit}-format-4`), 4),
    await stamped(outsideEntry, 4),
    await stamped(join(outsideFormat, commit), CHECKOUT_FORMAT)
  ]
  const second = join(options.root, 'linked-worktree')
  await mkdir(join(second, 'tests', 'e2e'), { recursive: true })
  await symlink(outsideCache, join(second, 'tests', 'e2e', '.cross-version-checkouts'), 'junction')
  options.targets.worktrees.push(second)
  await symlink(outsideLabel, join(options.cache, 'linked-label'), 'junction')
  await mkdir(join(options.cache, 'linked-entry'))
  await symlink(outsideEntry, join(options.cache, 'linked-entry', `${commit}-format-4`), 'junction')
  await symlink(outsideFormat, join(options.shared, `format-${CHECKOUT_FORMAT}`), 'junction')
  const result = await reclaimReleaseTestCaches({
    ...options,
    apply: true,
    testsStopped: true,
    minAgeDays: 0
  })
  expect(result.entries).toBe(0)
  for (const sentinel of sentinels) {
    expect(await readFile(join(sentinel, 'source.ts'), 'utf8')).toBe(
      'export const historical = true\n'
    )
  }
})

it('skips publication locks and a shared source copy lease', async () => {
  const options = await fixture()
  const local = await stamped(join(options.cache, 'v-old', `${commit}-format-4`), 4)
  const seed = await stamped(join(options.shared, `format-${CHECKOUT_FORMAT}`, commit))
  const release = await lock(local, { realpath: false })
  try {
    await withReleaseSourceLease(options.shared, async () => {
      const result = await reclaimReleaseTestCaches({ ...options, apply: true, testsStopped: true })
      expect(result.entries).toBe(0)
      expect(result.protected).toBe(2)
    })
  } finally {
    await release()
  }
  expect((await lstat(local)).isDirectory()).toBe(true)
  expect((await lstat(seed)).isDirectory()).toBe(true)
})

it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
  'rejects invalid minimum age %s',
  async (age) => {
    await expect(reclaimReleaseTestCaches({ minAgeDays: age })).rejects.toThrow('--min-age-days')
  }
)
