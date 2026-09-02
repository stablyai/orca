import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { countLooseRefs } from '../../shared/loose-ref-count'
import { RepoRefMaintenance } from '../../shared/repo-ref-maintenance'
import {
  _resetLocalRepoRefMaintenanceForTests,
  createLocalRepoRefMaintenanceTarget,
  getLocalRepoRefMaintenance,
  setRepoMaintenanceActivityProbe
} from './local-repo-ref-maintenance'
import { forceDeleteLocalBranch } from './worktree-branch-removal'

const roots: string[] = []
// Large enough that the deferral ladder (1x, 2x, 4x ... capped at 8x) outlasts
// three real `pack-refs` runs before the deferral budget is spent.
const QUIET_MS = 25
const THRESHOLD = 20

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
}

/** A repo whose only loose-ref backlog is the one the test asks for. */
async function createRepo(looseRefs: number): Promise<{ repoPath: string; refsDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-ref-maintenance-git-'))
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
  for (let index = 0; index < looseRefs; index += 1) {
    await writeFile(join(namespace, `branch-${index}`), `${head}\n`)
  }
  return { repoPath, refsDir: join(repoPath, '.git', 'refs') }
}

function createMaintenance(onPackRefs: () => void = () => {}): {
  maintenance: RepoRefMaintenance
  arm: (repoPath: string) => void
} {
  const maintenance = new RepoRefMaintenance({
    quietPeriodMs: QUIET_MS,
    looseRefThreshold: THRESHOLD
  })
  return {
    maintenance,
    arm: (repoPath: string) => {
      const target = createLocalRepoRefMaintenanceTarget({
        key: `local::${repoPath}`,
        repoPath
      })
      maintenance.arm({
        ...target,
        packRefs: async (signal) => {
          onPackRefs()
          await target.packRefs(signal)
        }
      })
    }
  }
}

async function settle(maintenance: RepoRefMaintenance): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, QUIET_MS * 4))
  await maintenance.whenAttemptSettled()
}

/** Deferred repos re-arm for another quiet period, so drain rather than count rounds. */
async function settleUntil(
  maintenance: RepoRefMaintenance,
  done: () => Promise<boolean>
): Promise<void> {
  for (let round = 0; round < 100; round += 1) {
    if (await done()) {
      return
    }
    await settle(maintenance)
  }
}

afterEach(async () => {
  _resetLocalRepoRefMaintenanceForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('idle ref maintenance against real Git', () => {
  it('packs a backlogged repository down to zero loose refs', async () => {
    const { repoPath, refsDir } = await createRepo(THRESHOLD + 30)
    const { maintenance, arm } = createMaintenance()

    await expect(countLooseRefs(refsDir, 10_000)).resolves.toMatchObject({
      count: THRESHOLD + 31
    })

    arm(repoPath)
    await settle(maintenance)
    maintenance.dispose()

    await expect(countLooseRefs(refsDir, 10_000)).resolves.toEqual({ count: 0, saturated: false })
    // The refs survived the move into packed-refs; nothing was lost.
    expect(git(repoPath, ['for-each-ref', '--format=%(refname)']).split('\n')).toHaveLength(
      THRESHOLD + 31
    )
    expect(git(repoPath, ['rev-parse', '--verify', 'refs/remotes/origin/branch-0'])).toMatch(
      /^[0-9a-f]{40}$/
    )
  }, 30_000)

  it('leaves a healthy repository untouched', async () => {
    const { repoPath, refsDir } = await createRepo(2)
    let packed = 0
    const { maintenance, arm } = createMaintenance(() => {
      packed += 1
    })

    arm(repoPath)
    await settle(maintenance)
    maintenance.dispose()

    expect(packed).toBe(0)
    await expect(countLooseRefs(refsDir, 10_000)).resolves.toMatchObject({ count: 3 })
  }, 30_000)

  it('honours maintenance.auto=false in the repository config', async () => {
    const { repoPath, refsDir } = await createRepo(THRESHOLD + 30)
    git(repoPath, ['config', 'maintenance.auto', 'false'])
    let packed = 0
    const { maintenance, arm } = createMaintenance(() => {
      packed += 1
    })

    arm(repoPath)
    await settle(maintenance)
    maintenance.dispose()

    expect(packed).toBe(0)
    await expect(countLooseRefs(refsDir, 10_000)).resolves.toMatchObject({
      count: THRESHOLD + 31
    })
  }, 30_000)

  it('runs one repository at a time even when several go quiet together', async () => {
    const repos = await Promise.all([
      createRepo(THRESHOLD + 5),
      createRepo(THRESHOLD + 5),
      createRepo(THRESHOLD + 5)
    ])
    let concurrent = 0
    let peak = 0
    const maintenance = new RepoRefMaintenance({
      quietPeriodMs: QUIET_MS,
      looseRefThreshold: THRESHOLD
    })
    for (const { repoPath } of repos) {
      const target = createLocalRepoRefMaintenanceTarget({
        key: `local::${repoPath}`,
        repoPath
      })
      maintenance.arm({
        ...target,
        packRefs: async (signal) => {
          concurrent += 1
          peak = Math.max(peak, concurrent)
          try {
            await target.packRefs(signal)
          } finally {
            concurrent -= 1
          }
        }
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

describe('yielding the repository to work that deletes refs', () => {
  it('waits for the packed-refs lock and succeeds while the prune continues', async () => {
    // The pack is never killed. `packed-refs.lock` is held for ~1.4s of a 30s
    // run; the rest is the prune, during which a concurrent `update-ref -d`
    // succeeds on its own because per-ref locks last microseconds. Signalling
    // the child there strands a `refs/**` lock Git never clears.
    const { repoPath } = await createRepo(0)
    git(repoPath, ['branch', 'doomed'])
    const head = git(repoPath, ['rev-parse', 'refs/heads/doomed'])

    let packing = false
    let releaseLock: (() => void) | undefined
    _resetLocalRepoRefMaintenanceForTests({ quietPeriodMs: QUIET_MS, looseRefThreshold: 1 })
    setRepoMaintenanceActivityProbe(() => false)
    getLocalRepoRefMaintenance().arm({
      key: `local::${repoPath}`,
      resolveRefsDirectory: async () => join(repoPath, '.git', 'refs'),
      packRefs: async (lock) => {
        packing = true
        lock.setHeld(true)
        // Stands in for the rewrite window, then the long prune that follows it.
        await new Promise<void>((resolve) => {
          releaseLock = () => {
            lock.setHeld(false)
            resolve()
          }
        })
      }
    })
    for (let attempt = 0; attempt < 200 && !packing; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, QUIET_MS))
    }
    expect(packing).toBe(true)

    // The real deletion path, which routes through withRepoRefMaintenancePaused.
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
    const { repoPath } = await createRepo(0)
    git(repoPath, ['branch', 'doomed'])
    const head = git(repoPath, ['rev-parse', 'refs/heads/doomed'])

    let pruning = false
    let finishPrune: (() => void) | undefined
    _resetLocalRepoRefMaintenanceForTests({ quietPeriodMs: QUIET_MS, looseRefThreshold: 1 })
    setRepoMaintenanceActivityProbe(() => false)
    getLocalRepoRefMaintenance().arm({
      key: `local::${repoPath}`,
      resolveRefsDirectory: async () => join(repoPath, '.git', 'refs'),
      packRefs: async (lock) => {
        lock.setHeld(true)
        lock.setHeld(false)
        pruning = true
        await new Promise<void>((resolve) => {
          finishPrune = resolve
        })
      }
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
