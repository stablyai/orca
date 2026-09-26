import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanLooseObjects } from '../../shared/loose-object-scan'
import { countLooseRefs } from '../../shared/loose-ref-count'
import { RepoMaintenance } from '../../shared/repo-maintenance'
import type { RepoMaintenanceTaskId } from '../../shared/repo-maintenance-policy'
import {
  _resetLocalRepoMaintenanceForTests,
  createLocalRepoMaintenanceTarget,
  getLocalRepoMaintenance,
  setRepoMaintenanceActivityProbe
} from './local-repo-maintenance'
import { forceDeleteLocalBranch } from './worktree-branch-removal'

const roots: string[] = []
// Large enough that the deferral ladder (1x, 2x, 4x ... capped at 8x) outlasts
// three real packs before the deferral budget is spent.
const QUIET_MS = 25
const REF_THRESHOLD = 20
const OBJECT_THRESHOLD = 20
/** High enough that the task under test is the only one that ever fires. */
const NEVER = 1_000_000

function git(cwd: string, args: string[], stdin?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(stdin === undefined ? {} : { input: stdin }),
    maxBuffer: 64 * 1024 * 1024
  }).trim()
}

type Repo = {
  repoPath: string
  refsDir: string
  objectsDir: string
  /** Ids of the unreachable objects the fixture created, if any. */
  unreachable: string[]
}

/**
 * A repo whose only backlog is the one the test asks for.
 *
 * `looseObjects` are blobs no tree or commit ever refers to and whose mtime is
 * now -- exactly what Orca's own `merge-tree --write-tree` leaves behind, and
 * exactly what `git gc` can neither pack nor prune.
 */
async function createRepo(
  options: { looseRefs?: number; looseObjects?: number } = {}
): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), 'orca-repo-maintenance-git-'))
  roots.push(root)
  const repoPath = join(root, 'repo')
  execFileSync('git', ['init', '--quiet', repoPath])
  git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repoPath, ['config', 'user.email', 'test@example.com'])
  git(repoPath, ['config', 'user.name', 'Test User'])
  await writeFile(join(repoPath, 'file.txt'), 'one\n')
  git(repoPath, ['add', 'file.txt'])
  git(repoPath, ['commit', '--quiet', '-m', 'initial'])
  const head = git(repoPath, ['rev-parse', 'HEAD'])
  // Written directly: `update-ref` for thousands of refs is the slow part of the fixture.
  const namespace = join(repoPath, '.git', 'refs', 'remotes', 'origin')
  await mkdir(namespace, { recursive: true })
  for (let index = 0; index < (options.looseRefs ?? 0); index += 1) {
    await writeFile(join(namespace, `branch-${index}`), `${head}\n`)
  }
  const unreachable = await writeUnreachableBlobs(root, repoPath, options.looseObjects ?? 0)
  return {
    repoPath,
    refsDir: join(repoPath, '.git', 'refs'),
    objectsDir: join(repoPath, '.git', 'objects'),
    unreachable
  }
}

/** One `hash-object` for the whole batch; thousands of children would dominate the test. */
async function writeUnreachableBlobs(
  root: string,
  repoPath: string,
  count: number
): Promise<string[]> {
  if (count === 0) {
    return []
  }
  const source = join(root, 'blobs')
  await mkdir(source, { recursive: true })
  const paths: string[] = []
  for (let index = 0; index < count; index += 1) {
    const path = join(source, `blob-${index}`)
    await writeFile(path, `unreachable ${index}\n`)
    paths.push(path)
  }
  return git(repoPath, ['hash-object', '-w', '--stdin-paths'], `${paths.join('\n')}\n`).split('\n')
}

type Harness = {
  maintenance: RepoMaintenance
  arm: (repoPath: string) => void
  packed: RepoMaintenanceTaskId[]
}

function createMaintenance(
  overrides: {
    refsThreshold?: number
    objectThreshold?: number
    batchSize?: number
  } = {}
): Harness {
  const packed: RepoMaintenanceTaskId[] = []
  const maintenance = new RepoMaintenance({
    quietPeriodMs: QUIET_MS,
    remainderDelayMs: QUIET_MS
  })
  return {
    maintenance,
    packed,
    arm: (repoPath: string) => {
      const target = createLocalRepoMaintenanceTarget({
        key: `local::${repoPath}`,
        repoPath,
        taskOverrides: {
          refsThreshold: overrides.refsThreshold ?? REF_THRESHOLD,
          objectThreshold: overrides.objectThreshold ?? OBJECT_THRESHOLD,
          ...(overrides.batchSize === undefined ? {} : { batchSize: overrides.batchSize })
        }
      })
      maintenance.arm({
        ...target,
        tasks: target.tasks.map((task) => ({
          ...task,
          pack: async (lock) => {
            packed.push(task.id)
            return task.pack(lock)
          }
        }))
      })
    }
  }
}

async function settle(maintenance: RepoMaintenance): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, QUIET_MS * 4))
  await maintenance.whenAttemptSettled()
}

/** Deferred repos re-arm for another quiet period, so drain rather than count rounds. */
async function settleUntil(
  maintenance: RepoMaintenance,
  done: () => Promise<boolean>
): Promise<void> {
  for (let round = 0; round < 100; round += 1) {
    if (await done()) {
      return
    }
    await settle(maintenance)
  }
}

/** Every byte of ref state, plus the index, so a change anywhere shows up. */
async function snapshotRefsAndIndex(repoPath: string): Promise<Record<string, string>> {
  const gitDir = join(repoPath, '.git')
  const snapshot: Record<string, string> = {}
  const walk = async (directory: string, prefix: string): Promise<void> => {
    let entries: { name: string; isDirectory: () => boolean }[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(path, `${prefix}${entry.name}/`)
        continue
      }
      snapshot[`${prefix}${entry.name}`] = (await readFile(path)).toString('base64')
    }
  }
  await walk(join(gitDir, 'refs'), 'refs/')
  for (const file of ['packed-refs', 'index', 'HEAD']) {
    try {
      snapshot[file] = (await readFile(join(gitDir, file))).toString('base64')
    } catch {
      // Absent is a fact worth capturing too, by its absence from the snapshot.
    }
  }
  return snapshot
}

/** One `cat-file` for the whole batch; the point is that every object still reads. */
function missingObjects(repoPath: string, ids: string[]): string[] {
  const output = git(repoPath, ['cat-file', '--batch-check'], `${ids.join('\n')}\n`)
  return output.split('\n').filter((line) => line.includes('missing'))
}

afterEach(async () => {
  _resetLocalRepoMaintenanceForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('idle ref maintenance against real Git', () => {
  it('packs a backlogged repository down to zero loose refs', async () => {
    const { repoPath, refsDir } = await createRepo({ looseRefs: REF_THRESHOLD + 30 })
    const { maintenance, arm } = createMaintenance()

    await expect(countLooseRefs(refsDir, 10_000)).resolves.toMatchObject({
      count: REF_THRESHOLD + 31
    })

    arm(repoPath)
    await settle(maintenance)
    maintenance.dispose()

    await expect(countLooseRefs(refsDir, 10_000)).resolves.toEqual({ count: 0, saturated: false })
    // The refs survived the move into packed-refs; nothing was lost.
    expect(git(repoPath, ['for-each-ref', '--format=%(refname)']).split('\n')).toHaveLength(
      REF_THRESHOLD + 31
    )
    expect(git(repoPath, ['rev-parse', '--verify', 'refs/remotes/origin/branch-0'])).toMatch(
      /^[0-9a-f]{40}$/
    )
  }, 30_000)

  it('leaves a healthy repository untouched', async () => {
    const { repoPath, refsDir } = await createRepo({ looseRefs: 2 })
    const { maintenance, arm, packed } = createMaintenance()

    arm(repoPath)
    await settle(maintenance)
    maintenance.dispose()

    expect(packed).toEqual([])
    await expect(countLooseRefs(refsDir, 10_000)).resolves.toMatchObject({ count: 3 })
  }, 30_000)

  it('runs one repository at a time even when several go quiet together', async () => {
    const repos = await Promise.all([
      createRepo({ looseRefs: REF_THRESHOLD + 5 }),
      createRepo({ looseRefs: REF_THRESHOLD + 5 }),
      createRepo({ looseRefs: REF_THRESHOLD + 5 })
    ])
    let concurrent = 0
    let peak = 0
    const maintenance = new RepoMaintenance({ quietPeriodMs: QUIET_MS })
    for (const { repoPath } of repos) {
      const target = createLocalRepoMaintenanceTarget({
        key: `local::${repoPath}`,
        repoPath,
        taskOverrides: { refsThreshold: REF_THRESHOLD, objectThreshold: NEVER }
      })
      maintenance.arm({
        ...target,
        tasks: target.tasks.map((task) => ({
          ...task,
          pack: async (lock) => {
            concurrent += 1
            peak = Math.max(peak, concurrent)
            try {
              return await task.pack(lock)
            } finally {
              concurrent -= 1
            }
          }
        }))
      })
    }

    const allPacked = async (): Promise<boolean> => {
      const counts = await Promise.all(repos.map(({ refsDir }) => countLooseRefs(refsDir, 10_000)))
      return counts.every((scan) => scan.count === 0)
    }
    await settleUntil(maintenance, allPacked)
    maintenance.dispose()

    expect(peak).toBe(1)
    for (const { refsDir } of repos) {
      await expect(countLooseRefs(refsDir, 10_000)).resolves.toEqual({
        count: 0,
        saturated: false
      })
    }
  }, 60_000)
})

describe('idle loose-object maintenance against real Git', () => {
  it('packs thousands of unreachable young objects without touching refs or the index', async () => {
    const repo = await createRepo({ looseObjects: 3000 })
    // Exactly what `gc` is helpless against: unreachable, and far younger than
    // `gc.pruneExpire`.
    expect(repo.unreachable).toHaveLength(3000)
    expect(git(repo.repoPath, ['count-objects', '-v'])).toContain('count: 3003')
    const before = await snapshotRefsAndIndex(repo.repoPath)

    // Only the object task is above its threshold, so refs are provably untouched.
    const { maintenance, arm, packed } = createMaintenance({ refsThreshold: NEVER })
    arm(repo.repoPath)
    await settle(maintenance)
    maintenance.dispose()

    expect(packed).toEqual(['objects'])
    await expect(scanLooseObjects(repo.objectsDir, 10_000)).resolves.toMatchObject({ count: 0 })
    // Packed, not deleted: every object still reads, by id.
    expect(missingObjects(repo.repoPath, repo.unreachable)).toEqual([])
    expect(git(repo.repoPath, ['cat-file', '-p', repo.unreachable[0]])).toBe('unreachable 0')
    expect(await snapshotRefsAndIndex(repo.repoPath)).toEqual(before)
    // And the repository is still whole by Git's own reckoning.
    expect(() => git(repo.repoPath, ['fsck', '--no-progress', '--connectivity-only'])).not.toThrow()
  }, 120_000)

  it('pays down a huge backlog in batches and re-arms for the remainder', async () => {
    const repo = await createRepo({ looseObjects: 300 })
    const { maintenance, arm, packed } = createMaintenance({
      refsThreshold: NEVER,
      batchSize: 100
    })

    arm(repo.repoPath)
    await settleUntil(maintenance, async () => {
      const scan = await scanLooseObjects(repo.objectsDir, 10_000)
      return scan.count < OBJECT_THRESHOLD
    })
    maintenance.dispose()

    // More than one batch, each one a whole attempt with its own busy check --
    // a single attempt never holds the admission slot for the whole backlog.
    expect(packed.length).toBeGreaterThan(1)
    expect(packed.every((id) => id === 'objects')).toBe(true)
    // It stops once the remainder is below the threshold, not at zero: below it,
    // the store costs nothing worth another pack.
    const remaining = await scanLooseObjects(repo.objectsDir, 10_000)
    expect(remaining.count).toBeLessThan(OBJECT_THRESHOLD)
    expect(missingObjects(repo.repoPath, repo.unreachable)).toEqual([])
  }, 120_000)

  it('packs refs and then objects inside one attempt', async () => {
    const repo = await createRepo({ looseRefs: REF_THRESHOLD + 5, looseObjects: 100 })
    const { maintenance, arm, packed } = createMaintenance()

    arm(repo.repoPath)
    await settle(maintenance)
    maintenance.dispose()

    expect(packed).toEqual(['refs', 'objects'])
    await expect(countLooseRefs(repo.refsDir, 10_000)).resolves.toMatchObject({ count: 0 })
    await expect(scanLooseObjects(repo.objectsDir, 10_000)).resolves.toMatchObject({ count: 0 })
    expect(missingObjects(repo.repoPath, repo.unreachable)).toEqual([])
  }, 60_000)
})

describe('a repository the user told Git not to maintain', () => {
  // Every spelling Git itself accepts as "off", not just the canonical one.
  for (const [key, value] of [
    ['maintenance.auto', 'false'],
    ['maintenance.auto', 'no'],
    ['maintenance.auto', 'off'],
    ['maintenance.auto', '0'],
    ['maintenance.auto', 'FALSE'],
    ['gc.auto', '0'],
    ['gc.auto', '-1']
  ]) {
    it(`is left entirely alone when ${key}=${value}`, async () => {
      const repo = await createRepo({ looseRefs: REF_THRESHOLD + 30, looseObjects: 100 })
      git(repo.repoPath, ['config', key, value])
      const before = await snapshotRefsAndIndex(repo.repoPath)
      const { maintenance, arm, packed } = createMaintenance()

      arm(repo.repoPath)
      await settle(maintenance)
      maintenance.dispose()

      expect(packed).toEqual([])
      await expect(countLooseRefs(repo.refsDir, 10_000)).resolves.toMatchObject({
        count: REF_THRESHOLD + 31
      })
      await expect(scanLooseObjects(repo.objectsDir, 10_000)).resolves.toMatchObject({
        count: 103
      })
      expect(await snapshotRefsAndIndex(repo.repoPath)).toEqual(before)
    }, 30_000)
  }

  it('still maintains a repository whose settings leave Git maintenance on', async () => {
    const repo = await createRepo({ looseObjects: 100 })
    git(repo.repoPath, ['config', 'maintenance.auto', 'yes'])
    git(repo.repoPath, ['config', 'gc.auto', '1k'])
    const { maintenance, arm, packed } = createMaintenance({ refsThreshold: NEVER })

    arm(repo.repoPath)
    await settle(maintenance)
    maintenance.dispose()

    expect(packed).toEqual(['objects'])
  }, 30_000)
})

describe('yielding the repository to work that deletes refs', () => {
  it('waits for the packed-refs lock and succeeds while the prune continues', async () => {
    // The pack is never killed. `packed-refs.lock` is held for ~1.4s of a 30s
    // run; the rest is the prune, during which a concurrent `update-ref -d`
    // succeeds on its own because per-ref locks last microseconds. Signalling
    // the child there strands a `refs/**` lock Git never clears.
    const { repoPath } = await createRepo()
    git(repoPath, ['branch', 'doomed'])
    const head = git(repoPath, ['rev-parse', 'refs/heads/doomed'])

    let packing = false
    let releaseLock: (() => void) | undefined
    _resetLocalRepoMaintenanceForTests({ quietPeriodMs: QUIET_MS })
    setRepoMaintenanceActivityProbe(() => ({ interactive: false, constrained: false }))
    getLocalRepoMaintenance().arm({
      key: `local::${repoPath}`,
      tasks: [
        {
          id: 'refs',
          threshold: 1,
          probeBacklog: async () => ({ count: 10, saturated: false }),
          pack: async (lock) => {
            packing = true
            lock.setHeld(true)
            // Stands in for the rewrite window, then the long prune that follows it.
            await new Promise<void>((resolve) => {
              releaseLock = () => {
                lock.setHeld(false)
                resolve()
              }
            })
            return { batchExhausted: false }
          }
        }
      ]
    })
    for (let attempt = 0; attempt < 200 && !packing; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, QUIET_MS))
    }
    expect(packing).toBe(true)

    // The real deletion path, which routes through withRepoMaintenancePaused.
    let deleted = false
    const deletion = forceDeleteLocalBranch(repoPath, 'doomed', head).then(() => {
      deleted = true
    })

    // It must still be waiting: the rewrite window is open.
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS * 4))
    expect(deleted).toBe(false)
    expect(git(repoPath, ['branch', '--list', 'doomed'])).toContain('doomed')

    // Releasing the window is enough -- the pack is never cancelled.
    releaseLock?.()
    await deletion
    expect(deleted).toBe(true)
    expect(git(repoPath, ['branch', '--list', 'doomed'])).toBe('')
  }, 30_000)

  it('does not block the caller once the rewrite window has closed', async () => {
    // The prune phase is concurrency-safe, so a caller arriving during it pays
    // nothing at all.
    const { repoPath } = await createRepo()
    git(repoPath, ['branch', 'doomed'])
    const head = git(repoPath, ['rev-parse', 'refs/heads/doomed'])

    let pruning = false
    let finishPrune: (() => void) | undefined
    _resetLocalRepoMaintenanceForTests({ quietPeriodMs: QUIET_MS })
    setRepoMaintenanceActivityProbe(() => ({ interactive: false, constrained: false }))
    getLocalRepoMaintenance().arm({
      key: `local::${repoPath}`,
      tasks: [
        {
          id: 'refs',
          threshold: 1,
          probeBacklog: async () => ({ count: 10, saturated: false }),
          pack: async (lock) => {
            lock.setHeld(true)
            lock.setHeld(false)
            pruning = true
            await new Promise<void>((resolve) => {
              finishPrune = resolve
            })
            return { batchExhausted: false }
          }
        }
      ]
    })
    for (let attempt = 0; attempt < 200 && !pruning; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, QUIET_MS))
    }

    const startedAt = Date.now()
    await expect(forceDeleteLocalBranch(repoPath, 'doomed', head)).resolves.toBeUndefined()
    expect(Date.now() - startedAt).toBeLessThan(2_000)

    finishPrune?.()
  }, 30_000)
})
